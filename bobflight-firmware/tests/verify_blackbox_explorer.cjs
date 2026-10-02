/* SPDX-License-Identifier: Apache-2.0
 * Independent stock-Explorer oracle for host_blackbox_card's 600-sample output.
 * Usage: NODE_PATH=<esbuild+semver+pinia+vue modules> node this-file.cjs <viewer checkout> <file.bbl>
 * The external GPL viewer is not vendored or linked into BobFlight firmware. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const esbuild=require('esbuild');
const viewer=path.resolve(process.argv[2]),file=path.resolve(process.argv[3]);
const pinned='a84755c5e897c1a3a580424b64c0df066c12c6b4';
assert.equal(cp.execFileSync('git',['-C',viewer,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pinned);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bobflight-explorer-'));
try {
 for(const name of ['flightlog_parser','flightlog'])esbuild.buildSync({entryPoints:[path.join(viewer,'src',name+'.js')],outfile:path.join(tmp,name+'.cjs'),bundle:true,format:'cjs',platform:'node',nodePaths:(process.env.NODE_PATH||'').split(path.delimiter).filter(Boolean)});
 const {FlightLogParser}=require(path.join(tmp,'flightlog_parser.cjs'));
 const {FlightLog}=require(path.join(tmp,'flightlog.cjs'));
 function decode(data){let p=new FlightLogParser(data),frames=[],events=[];const log=console.log;try{console.log=()=>{};p.parseHeader(0,data.length);}finally{console.log=log;}
 p.onFrameReady=(valid,frame,type)=>{assert(valid,'invalid frame');if(type==='I')frames.push([...frame]);if(type==='E')events.push(frame);};p.parseLogData(false);return {p,frames,events};}
 const bytes=fs.readFileSync(file),{p,frames,events}=decode(bytes),index=p.frameDefs.I.nameToIndex;
 assert.equal(frames.length,600);assert.equal(p.stats.totalCorruptFrames,0);assert.equal(events.length,1);assert.equal(p.frameDefs.I.name.length,54);assert.equal(index.bobflightIteration,undefined);
 assert.match(bytes.subarray(0,4096).toString(),/H BobFlight log_schema:3\n/);
 assert.match(bytes.subarray(0,200).toString(),/Firmware revision:BobFlight/);
 const view=Object.create(FlightLog.prototype);view.getSysConfig=()=>p.sysConfig;
 const field=(frame,name)=>frame[index[name]];
 for(let j=0;j<600;j++){
  let f=frames[j];assert.equal(field(f,'loopIteration'),j*2);assert.equal(field(f,'time'),1000+j*2000);
  for(const [name,v] of Object.entries({'gyroADC[0]':250,'gyroADC[1]':-125,'gyroADC[2]':40,'bobflightRawGyro[0]':260,'setpoint[0]':35,'setpoint[1]':-10,'setpoint[2]':5,'axisP[0]':20,'axisP[1]':5,'axisP[2]':2,'axisD[0]':0,'axisD[1]':0,'axisD[2]':0,'motor[0]':447,'motor[1]':847,'motor[2]':1247,'motor[3]':1647,'bobflightError[0]':10,'bobflightError[1]':3,'bobflightError[2]':1,'bobflightSchema':3,'bobflightPidValid':1,'bobflightGyroValid':1,'bobflightRxFresh':1,'bobflightOutputHealthy':1,'bobflightDropped':0,'eRPM[0]':0,'eRPM[1]':0,'eRPM[2]':0,'eRPM[3]':0,'bobflightTelemOk':0,'bobflightFilterFlags':0,'bobflightEvents':0,'bobflightLoopCode':0,'bobflightOverruns':0}))assert.equal(field(f,name),v,`sample ${j} ${name}`);
  assert.equal(field(f,'bobflightDtUs'),j?1000:0);
 }
 for(const [j,i,out] of [[0,0,20],[1,0,20],[299,6,26],[599,12,32]]){assert.equal(field(frames[j],'axisI[0]'),i);assert.equal(field(frames[j],'bobflightOutput[0]'),out);console.log(`sample[${j}]: iteration=${field(frames[j],'loopIteration')}, time_us=${field(frames[j],'time')}, P=20, I=${i}, output=${out}`);}
 assert(Math.abs(view.gyroRawToDegreesPerSecond(250)-25)<.00001);
 assert.equal(view.rcMotorRawToPctPhysical(0),0);assert.equal(view.rcMotorRawToPctPhysical(48),0);assert.equal(view.rcMotorRawToPctPhysical(2047),100);
 assert(Math.abs(view.rcMotorRawToPctPhysical(447)-100*399/1999)<1e-8);
 // BB1 QA F1: the standard `H motor_poles:` header is present once, equals the config value (written as
 // `H BobFlight motor_poles`), is parsed by Explorer, and Explorer's own eRPM presenter scales with it
 // (value*200/motor_poles rpm). Without the line Explorer assumes 1 pole and shows RPM 14x too high.
 const head=bytes.subarray(0,4096).toString(),std=head.match(/\nH motor_poles:(\d+)\n/),bf=head.match(/\nH BobFlight motor_poles:([0-9.]+)\n/);
 assert(std,'standard H motor_poles header present');assert(bf,'H BobFlight motor_poles present');
 assert.equal((head.match(/\nH motor_poles:/g)||[]).length,1);
 const poles=Number(std[1]);assert.equal(poles,Number(bf[1]),'H motor_poles == configured motor_poles');assert.equal(poles,14,'card fixture: default motor_poles 14');
 assert.equal(p.sysConfig.motor_poles,poles,'Explorer sysConfig.motor_poles from the standard key');
 esbuild.buildSync({entryPoints:[path.join(viewer,'src','flightlog_fields_presenter.js')],outfile:path.join(tmp,'presenter.cjs'),bundle:true,format:'cjs',platform:'node',logLevel:'silent',external:['pinia','vue'],nodePaths:(process.env.NODE_PATH||'').split(path.delimiter).filter(Boolean)});
 {const pinia=require('pinia');pinia.setActivePinia(pinia.createPinia());}
 const pres=require(path.join(tmp,'presenter.cjs')),P=pres.FlightLogFieldPresenter||pres.default||pres;
 for(const raw of [2000,123,1,0]){ // raw = eRPM/100 as logged; independent truth: mech RPM = eRPM / (poles/2)
  const shown=P.decodeFieldToFriendly(view,'eRPM[0]',raw),m=shown.match(/^(\d+) rpm \/ ([0-9.]+) hz$/),rpm=raw*100/(poles/2);
  assert(m,`presenter format: ${shown}`);assert.equal(m[1],rpm.toFixed(0),`eRPM raw ${raw}: ${shown}`);
  assert(Math.abs(Number(m[2])-rpm/60)<=Math.max(0.1,rpm/60*1e-3),`eRPM raw ${raw} hz: ${shown}`);}
 assert.equal(P.decodeFieldToFriendly(view,'eRPM[0]',2000).split(' / ')[0],'28571 rpm');
 console.log(`motor_poles: H motor_poles:${poles} == H BobFlight motor_poles:${bf[1]}; Explorer eRPM[0] raw 2000 -> ${P.decodeFieldToFriendly(view,'eRPM[0]',2000)}`);
 const padded=decode(Buffer.concat([bytes,Buffer.alloc(512,0xff)]));assert.equal(padded.frames.length,600);assert.equal(padded.p.stats.totalCorruptFrames,0);
 console.log(`PASS stock Explorer ${pinned}: 600 frames, 54 fields (schema 3), direct recorded signals, zero corruption, EOF/padding, gyro conversion, DShot stop/mid/max physical percentage and eRPM -> RPM with H motor_poles`);
 console.log('Legacy computed rcCommands/axisError remain unsupported for BobFlight; use recorded setpoint and bobflightError. This does not test the graphical app or real hardware.');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
