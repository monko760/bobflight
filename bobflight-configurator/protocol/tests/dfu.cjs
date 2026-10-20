const assert = require('node:assert/strict');
const fs = require('node:fs');
const { WebUsbDfuFlasher } = require('../dist/flasher/webusb-dfu.js');
const { parseIntelHex } = require('../dist/flasher/intel-hex.js');
const { planSectorErases, planFullChipErases, assertMainFlashLayout } = require('../dist/flasher/flash-sectors.js');
const { F405_DIAGNOSTIC_MARKERS, validateF405DiagnosticImage } = require('../dist/flasher/f405-diagnostic.js');
const BASE = 0x08000000;

// Models DFU transitions and NOR flash (writes cannot turn zero bits back to one).
// Deliberately return offset DataViews, as permitted by WebUSB.
class Device {
  vendorId = 0x0483; productId = 0xdf11; opened = true;
  configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
    interfaceClass: 0xfe, interfaceSubclass: 1, alternateSetting: 0,
  }] }] };
  memory = Buffer.alloc(1024 * 1024, 0);
  state = 2; status = 0; pointer = BASE; erases = []; writes = 0; uploads = 0; clears = 0; leaves = 0;
  constructor(fault = '') { this.fault = fault; if (fault === 'stale') { this.state = 10; this.status = 3; } }
  async claimInterface() {} async selectAlternateInterface() {} async releaseInterface() {} async close() {}
  async controlTransferOut(s, data = new Uint8Array()) {
    this.outRequests=(this.outRequests||0)+1;
    if (s.request === 4) { this.clears++; this.status = 0; this.state = 2; }
    else if (s.request === 6) { assert.ok([2,5,9].includes(this.state), 'ABORT only from idle states'); this.state = 2; }
    else if (s.request === 1) {
      assert.ok([2,5].includes(this.state), 'DNLOAD must not follow UPLOAD without ABORT');
      if (!data.length) { this.leaves++; this.state = 6; }
      else {
        this.pending = () => {
          if (s.value === 0) {
            const address = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1,true);
            if (data[0] === 0x21) this.pointer = address;
            else if (data[0] === 0x41) {
              if (this.fault === 'erase') { this.status = 4; this.state = 10; return; }
              const bounds = this.f722 ? [0,16384,32768,49152,65536,131072,262144,393216,524288] : this.f405 ? [0,16384,32768,49152,65536,131072,262144,393216,524288,655360,786432,917504,1048576] : [0,32768,65536,98304,131072,262144,524288,786432,1048576];
              const i = bounds.findIndex((x,i) => i < bounds.length-1 && address-BASE >= x && address-BASE < bounds[i+1]);
              assert.ok(i >= 0); this.erases.push(BASE+bounds[i]);
              if (this.fault !== 'incomplete-erase' || i !== bounds.length-2) this.memory.fill(255,bounds[i],bounds[i+1]);
            } else assert.fail('unexpected command');
          } else {
            assert.equal(s.value,2);
            if (this.requireBlank && this.writes === 0) assert(this.memory.subarray(0,this.f722?524288:1048576).every(b=>b===255),'all main flash blank before FIRST program');
            this.writes++;
            if (this.fault === 'write') { this.status = 3; this.state = 10; return; }
            const off = this.pointer-BASE;
            for (let i=0;i<data.length;i++) {
              if ((this.memory[off+i] & data[i]) !== data[i]) { this.status = 3; this.state = 10; return; }
              this.memory[off+i] &= data[i];
            }
          }
        };
        this.state = 3;
      }
    } else assert.fail('unexpected OUT '+s.request);
    return { status:'ok', bytesWritten: this.fault === 'short-write' && s.value === 2 ? data.length-1 : data.length };
  }
  async controlTransferIn(s,n) {
    if(s.requestType==='standard' && this.descriptors)return this.descriptors.controlTransferIn(s,n);
    let data;
    if(s.request === 3) {
      if(this.state === 6 && this.fault === 'disconnect') { const e = new Error('device disconnected'); e.name = 'NetworkError'; throw e; }
      if(this.state === 3) this.state = 4;
      else if(this.state === 4) { this.state = 5; this.pending(); this.pending = null; }
      if (this.state === 6 && this.fault === 'leave') { this.state = 10; this.status = 1; }
      data = Uint8Array.from([this.status,0,0,0,this.state,0]);
    } else if(s.request === 2) {
      assert.ok([2,9].includes(this.state),'UPLOAD requires dfuIDLE/UPLOAD_IDLE');
      assert.equal(s.value,2); this.state = 9; this.uploads++;
      data = Uint8Array.from(this.memory.subarray(this.pointer-BASE,this.pointer-BASE+n));
      if(this.fault === 'corrupt') data[0] ^= 1;
      if(this.fault === 'short-read') data = data.subarray(0,n-1);
    } else assert.fail('unexpected IN');
    const backing = new Uint8Array(data.length+8); backing.set(data,4);
    return { status:'ok', data: new DataView(backing.buffer,4,data.length) };
  }
}
global.window = { isSecureContext:true };
async function run(image, fault='', options={}) {
  const device = new Device(fault);
  device.f722 = options.expectedMcu === 'F722';
  device.requireBlank = options.eraseMode === 'full-chip';
  if ('layout' in options) device.configuration.interfaces[0].alternates[0].interfaceName=options.layout;
  if(device.f722) { // incompatible old configuration in both reserved slots
    for(const offset of [0x4000,0x8000]) {device.memory.writeUInt32LE(0x42464346,offset);device.memory.writeUInt32LE(12,offset+4);}
  }
  if(options.rawDescriptor)device.descriptors=require('./fixtures/dfu-descriptors.cjs').device(options.rawDescriptor);
  if(options.expectedMcu==='F405') {
    device.f405=true;
    device.configuration.interfaces[0].alternates[0].interfaceName='layout' in options ? options.layout : '@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg';
  }
  Object.defineProperty(global,'navigator',{configurable:true,value:{usb:{async requestDevice(){return device;}}}});
  const flasher = new WebUsbDfuFlasher(); const phases=[];
  if(fault==='cancel-descriptor') {
    const original=device.descriptors.controlTransferIn.bind(device.descriptors);
    device.descriptors.controlTransferIn=async(s,n)=>{const result=await original(s,n);flasher.cancel();return result;};
  }
  flasher.onProgress(p => { phases.push(p); if((fault === 'cancel' && p.phase === 'writing') ||
    (fault === 'cancel-erase' && p.phase === 'erasing') ||
    (fault === 'cancel-blank' && p.message?.startsWith('Full erase: verified blank')) ||
    (fault === 'cancel-mid-erase' && device.erases.length===1 && p.phase === 'erasing')) flasher.cancel(); });
  await flasher.requestDevice();
  let error;
  try { await flasher.flash(image,{expectedMcu:'F745',verify:true,leave:true,...options}); } catch(e) { error=e; }
  return {device,phases,error};
}
function region(address,length) { return {address,data:Uint8Array.from({length},(_,i)=>(i*17+83)&255)}; }
function parsed(regions) { return {baseAddress:regions[0].address,regions,bytes:new Uint8Array()}; }
(async()=>{
  // Same region boundaries as cdc15; vector region and code start share sector zero.
  const image = parsed([region(BASE,336),region(BASE+0x180,79936)]);
  const ok = await run(image);
  assert.ifError(ok.error); assert.deepEqual(ok.device.erases,[BASE,BASE+32768,BASE+65536]);
  for(const r of image.regions) assert.deepEqual(ok.device.memory.subarray(r.address-BASE,r.address-BASE+r.data.length),Buffer.from(r.data));
  assert.ok(ok.device.uploads>0); assert.equal(ok.device.leaves,1); assert.equal(ok.phases.at(-1).phase,'done');
  assert.equal(ok.device.memory[98304],0,'unrelated sector unchanged');
  for(const [fault,pattern] of [['erase',/Erase.*device error/],['write',/Write.*device error/],['corrupt',/Verification mismatch/],['short-read',/short read/],['short-write',/short write/],['cancel',/cancelled/]]) {
    const r = await run(image,fault); assert.match(r.error?.message ?? '',pattern);
    assert.equal(r.device.leaves,0); assert.equal(r.device.clears,0); assert.ok(!r.phases.some(p=>p.phase==='done'));
  }
  const stale = await run(image,'stale'); assert.ifError(stale.error); assert.equal(stale.device.clears,1);
  const leave = await run(image,'leave'); assert.match(leave.error?.message ?? '',/leave failed/); assert.ok(!leave.phases.some(p=>p.phase==='done'));
  const short = await run(parsed([region(BASE,2051)])); assert.ifError(short.error); assert.equal(short.device.uploads,2);
  const single = await run(parsed([region(BASE+1048575,1)])); assert.ifError(single.error);
  const disconnected = await run(image,'disconnect'); assert.ifError(disconnected.error); assert.equal(disconnected.phases.at(-1).phase,'done');
  assert.deepEqual(planSectorErases([region(BASE+32767,1)],'F745'),[BASE]);
  assert.deepEqual(planSectorErases([region(BASE+32767,2)],'F745'),[BASE,BASE+32768]);
  assert.deepEqual(planSectorErases([region(BASE+65535,2)],'F722'),[BASE+49152,BASE+65536]);
  assert.deepEqual(planSectorErases([region(BASE+131071,2)],'F745'),[BASE+98304,BASE+131072]);
  for(const image of [parsed([region(BASE-1,1)]),parsed([region(BASE+1048576,1)])]) {
    const bad = await run(image); assert.ok(bad.error); assert.equal(bad.device.erases.length,0); assert.equal(bad.device.writes,0);
  }
  assert.throws(()=>planSectorErases([region(BASE,1)],undefined),/supported target/);

  const d=Buffer.alloc(20000);
  d.writeUInt32LE(0x20020000,0); for(const o of [4,60,332])d.writeUInt32LE(BASE+393,o);
  let markerOffset=512;for(const marker of F405_DIAGNOSTIC_MARKERS){d.write(marker+'\0',markerOffset,'ascii');markerOffset+=marker.length+1;}
  const diagnostic={baseAddress:BASE,bytes:d,regions:[{address:BASE,data:d}]};
  const diagnosticOptions={expectedMcu:'F405',imageProfile:'f405-usb-diagnostic',verify:true,leave:false};
  const f405=await run(diagnostic,'',diagnosticOptions);assert.ifError(f405.error);
  assert.deepEqual(f405.device.erases,[BASE,BASE+16384]);assert.equal(f405.device.leaves,0);
  assert(f405.device.uploads>0);assert.deepEqual(f405.device.memory.subarray(0,d.length),d);
  assert.equal(f405.device.memory[32768],0);assert.match(f405.phases.at(-1).message,/remove BOOT/);
  for(const layout of [null,'','   ']) {
    const raw=await run(diagnostic,'',{...diagnosticOptions,layout,rawDescriptor:{}});assert.ifError(raw.error);
    assert.equal(raw.device.descriptors.requests.length,5);assert.deepEqual(raw.device.erases,[BASE,BASE+16384]);assert.equal(raw.device.leaves,0);
  }
  for(const rawDescriptor of [{stall:true},{layout:'@Internal Flash /0x08000000/04*016Kg,01*064Kg,03*128Kg'}]) {
    const bad=await run(diagnostic,'',{...diagnosticOptions,layout:null,rawDescriptor});assert(bad.error);assert.equal(bad.device.outRequests||0,0);
  }
  const cancelledRead=await run(diagnostic,'cancel-descriptor',{...diagnosticOptions,layout:null,rawDescriptor:{}});
  assert.match(cancelledRead.error?.message??'',/cancelled/i);assert.equal(cancelledRead.device.outRequests||0,0);
  const contradiction=await run(diagnostic,'',{...diagnosticOptions,layout:'@Internal Flash /0x08000000/04*016Kg,01*064Kg,03*128Kg',rawDescriptor:{}});
  assert(contradiction.error);assert.equal(contradiction.device.descriptors.requests.length,0);assert.equal(contradiction.device.outRequests||0,0);
  for(const layout of [null,'@Internal Flash /0x08000000/04*016Kg,01*064Kg,03*128Kg','@Internal Flash /0x08000000/04*032Kg,01*128Kg,03*256Kg','@Internal Flash /0x08004000/04*016Kg,01*064Kg,07*128Kg']) {
    const bad=await run(diagnostic,'',{...diagnosticOptions,layout});assert(bad.error);
    assert.equal(bad.device.outRequests||0,0,'bad geometry must precede all DFU writes');
  }
  for(const opt of [{leave:true},{verify:false},{imageProfile:undefined},{expectedMcu:'F722'}]) {
    const bad=await run(diagnostic,'',{...diagnosticOptions,...opt});assert(bad.error);assert.equal(bad.device.outRequests||0,0);
  }
  // Explicit full internal-flash erase: all sectors, never just image ranges.
  const fullLayouts={F722:'@Internal Flash /0x08000000/04*016Kg,01*064Kg,03*128Kg',F745:'@Internal Flash /0x08000000/04*032Kg,01*128Kg,03*256Kg'};
  const fullData=region(BASE,128).data;const fullVectors=new DataView(fullData.buffer);
  fullVectors.setUint32(0,0x20010000,true);fullVectors.setUint32(4,BASE+9,true);
  const small={baseAddress:BASE,bytes:fullData,regions:[{address:BASE,data:fullData}]};
  for(const expectedMcu of ['F722','F745']) {
    const result=await run(small,'',{expectedMcu,eraseMode:'full-chip',layout:fullLayouts[expectedMcu]});assert.ifError(result.error);
    assert.deepEqual(result.device.erases,planFullChipErases(expectedMcu));
    const size=expectedMcu==='F722'?524288:1048576;
    assert.deepEqual(result.device.memory.subarray(0,128),Buffer.from(small.regions[0].data));
    assert(result.device.memory.subarray(128,size).every(b=>b===255),'settings and all other unwritten flash stay erased');
    if(expectedMcu==='F722')assert(result.device.memory.subarray(size).every(b=>b===0),'no writes outside selected flash');
    assert(result.device.uploads>=size/2048+1,'full blank readback plus programmed-image verification');
    assert.match(result.phases.at(-1).message,/settings removed/);
  }
  const allF405=await run(diagnostic,'',{...diagnosticOptions,eraseMode:'full-chip'});assert.ifError(allF405.error);
  assert.deepEqual(allF405.device.erases,planFullChipErases('F405'));assert.equal(allF405.device.leaves,0);
  assert(allF405.device.memory.subarray(d.length).every(b=>b===255));
  const selective=await run(small,'',{expectedMcu:'F722'});assert.ifError(selective.error);
  assert.deepEqual(selective.device.erases,[BASE]);assert.equal(selective.device.memory.readUInt32LE(0x4000),0x42464346,'default selective erase still preserves untouched config');
  for(const layout of [null,'','@OTP Memory /0x1fff7800/01*512Bg','@Internal Flash /0x08000000/04*016Kg,01*064Kg,01*128Kg',fullLayouts.F745,'@Internal Flash /0x08000000/04*016Ka,01*064Kg,03*128Kg']) {
    const bad=await run(small,'',{expectedMcu:'F722',eraseMode:'full-chip',layout});assert(bad.error);assert.equal(bad.device.outRequests||0,0,'geometry refusal before DFU writes');
  }
  const rawFull=await run(small,'',{expectedMcu:'F722',eraseMode:'full-chip',layout:null,rawDescriptor:{layout:fullLayouts.F722}});assert.ifError(rawFull.error);assert.deepEqual(rawFull.device.erases,planFullChipErases('F722'));
  for(const opt of [{verify:false},{expectedMcu:undefined},{eraseMode:'typo'}]) {
    const bad=await run(small,'',{expectedMcu:'F722',eraseMode:'full-chip',layout:fullLayouts.F722,...opt});assert(bad.error);assert.equal(bad.device.outRequests||0,0);
  }
  for(const fault of ['incomplete-erase','erase','short-read','corrupt','cancel-erase','cancel-blank','cancel-mid-erase','write','short-write','cancel']) {
    const bad=await run(small,fault,{expectedMcu:'F722',eraseMode:'full-chip',layout:fullLayouts.F722});assert(bad.error,fault);assert.equal(bad.device.leaves,0,fault);assert(!bad.phases.some(p=>p.phase==='done'),fault);
    if(!['write','short-write','cancel'].includes(fault))assert.equal(bad.device.writes,0,'no programming after erase/blank-check failure');
    if(fault==='cancel-erase')assert.equal(bad.device.erases.length,0);
    if(fault==='incomplete-erase')assert.match(bad.error.message,/blank verification failed/);
  }
  for(const badImage of [
    parsed([region(BASE,2)]),
    {...small,baseAddress:BASE+16},
    {...small,regions:[]},
    {...small,bytes:new Uint8Array(128)},
    {...small,entryAddress:BASE+512},
    {...small,regions:[...small.regions,...small.regions]},
  ]) {
    const bad=await run(badImage,'',{expectedMcu:'F722',eraseMode:'full-chip',layout:fullLayouts.F722});assert(bad.error);assert.equal(bad.device.outRequests||0,0,'invalid image before destructive operations');
  }
  const cancelLayout=await run(small,'cancel-descriptor',{expectedMcu:'F722',eraseMode:'full-chip',layout:null,rawDescriptor:{layout:fullLayouts.F722}});assert(cancelLayout.error);assert.equal(cancelLayout.device.outRequests||0,0);
  for(const target of ['F722','F745','F405'])assert.equal(new Set(planFullChipErases(target)).size,planFullChipErases(target).length);
  assert.throws(()=>planFullChipErases('unknown'),/supported/);
  assert.throws(()=>assertMainFlashLayout(fullLayouts.F722,'F745'),/geometry/);
  console.log('PASS full internal-flash erase: exact geometry, all sectors/config erased, complete blank verification before program, default preservation, F405 cold restart, refusal/error/cancellation cases.');
  const wrong=d.slice();wrong[512]=0;
  assert.throws(()=>validateF405DiagnosticImage({...diagnostic,bytes:wrong,regions:[{address:BASE,data:wrong}]}),/identity/);
  const overflow={...diagnostic,regions:[...diagnostic.regions,{address:0x080c0000,data:new Uint8Array(1)}]};
  assert.throws(()=>validateF405DiagnosticImage(overflow),/range/);
  for(const fault of ['corrupt','short-read','short-write','write','erase','cancel']){
    const bad=await run(diagnostic,fault,diagnosticOptions);assert(bad.error);assert.equal(bad.device.leaves,0);assert(!bad.phases.some(p=>p.phase==='done'));
  }
  if(process.env.BF_F405_TEST_HEX){
    const real=parseIntelHex(fs.readFileSync(process.env.BF_F405_TEST_HEX,'utf8'));
    const result=await run(real,'',diagnosticOptions);assert.ifError(result.error);assert.equal(result.device.leaves,0);
    for(const region of real.regions)assert.deepEqual(result.device.memory.subarray(region.address-BASE,region.address-BASE+region.data.length),Buffer.from(region.data));
    console.log('PASS exact existing F405 HEX: all programmed bytes readback verified in DFU model; no ROM jump.');
  }
  console.log('PASS F405 profile, geometry-before-write, 16 KiB sectors, readback, preserved sectors, corruption/errors/cancellation, and mandatory cold restart.');
  if(process.env.BF_FULL_ERASE_TEST_HEX) {
    const real=parseIntelHex(fs.readFileSync(process.env.BF_FULL_ERASE_TEST_HEX,'utf8'));
    const result=await run(real,'',{expectedMcu:'F722',eraseMode:'full-chip',layout:fullLayouts.F722});assert.ifError(result.error);
    assert.deepEqual(result.device.erases,planFullChipErases('F722'));
    for(const r of real.regions)assert.deepEqual(result.device.memory.subarray(r.address-BASE,r.address-BASE+r.data.length),Buffer.from(r.data));
    assert(result.device.memory.subarray(0x4000,0xc000).every(b=>b===255),'both Matek configuration sectors remain erased after actual firmware programming');
    console.log('PASS actual Matek HEX full erase: all image bytes verified and both reserved configuration sectors blank in simulated NOR flash.');
  }
  if(process.argv[2]) {
    const real = parseIntelHex(fs.readFileSync(process.argv[2],'utf8'));
    const result = await run(real); assert.ifError(result.error);
    assert.deepEqual(result.device.erases,[BASE,BASE+32768,BASE+65536]);
    console.log('Exact supplied HEX: all data bytes written and verified in simulated flash.');
  }
  console.log('PASS: sector coverage, deduplication, F722/F745 boundaries, stale-error recovery, programming errors, short transfers, readback mismatch, cancellation, DFU state transitions, leave errors, and address bounds.');
})().catch(e=>{console.error(e);process.exitCode=1;});
