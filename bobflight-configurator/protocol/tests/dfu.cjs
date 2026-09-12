const assert = require('node:assert/strict');
const fs = require('node:fs');
const { WebUsbDfuFlasher } = require('../dist/flasher/webusb-dfu.js');
const { parseIntelHex } = require('../dist/flasher/intel-hex.js');
const { planSectorErases } = require('../dist/flasher/flash-sectors.js');
const BASE = 0x08000000;

// Models DFU transitions and NOR flash (writes cannot turn zero bits back to one).
// Deliberately return offset DataViews, as permitted by WebUSB.
class Device {
  vendorId = 0x0483; productId = 0xdf11; opened = true;
  configuration = { interfaces: [{ interfaceNumber: 0, alternates: [{
    interfaceClass: 0xfe, interfaceSubclass: 1, alternateSetting: 0,
  }] }] };
  memory = Buffer.alloc(1024 * 1024, 0);
  state = 2; status = 0; pointer = BASE; erases = []; writes = 0; uploads = 0; clears = 0; leaves = 0;
  constructor(fault = '') { this.fault = fault; if (fault === 'stale') { this.state = 10; this.status = 3; } }
  async claimInterface() {} async selectAlternateInterface() {} async releaseInterface() {} async close() {}
  async controlTransferOut(s, data = new Uint8Array()) {
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
              const bounds = [0,32768,65536,98304,131072,262144,524288,786432,1048576];
              const i = bounds.findIndex((x,i) => i < bounds.length-1 && address-BASE >= x && address-BASE < bounds[i+1]);
              assert.ok(i >= 0); this.erases.push(BASE+bounds[i]);
              this.memory.fill(255,bounds[i],bounds[i+1]);
            } else assert.fail('unexpected command');
          } else {
            assert.equal(s.value,2); this.writes++;
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
  Object.defineProperty(global,'navigator',{configurable:true,value:{usb:{async requestDevice(){return device;}}}});
  const flasher = new WebUsbDfuFlasher(); const phases=[];
  flasher.onProgress(p => { phases.push(p); if(fault === 'cancel' && p.phase === 'writing') flasher.cancel(); });
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
  if(process.argv[2]) {
    const real = parseIntelHex(fs.readFileSync(process.argv[2],'utf8'));
    const result = await run(real); assert.ifError(result.error);
    assert.deepEqual(result.device.erases,[BASE,BASE+32768,BASE+65536]);
    console.log('Exact supplied HEX: all data bytes written and verified in simulated flash.');
  }
  console.log('PASS: sector coverage, deduplication, F722/F745 boundaries, stale-error recovery, programming errors, short transfers, readback mismatch, cancellation, DFU state transitions, leave errors, and address bounds.');
})().catch(e=>{console.error(e);process.exitCode=1;});
