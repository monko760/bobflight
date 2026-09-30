/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * status loop_target_hz / loop_actual_hz / loop_overruns parser, view model and MockSerial scenarios. */
const assert=require('node:assert/strict');
const {parseLoopStatus,loopRateView,parseUint64,LOOP_LABELS,LOOP_RATE_MOCK_SCENARIOS,mockLoopStatusLines,BobFlightCliClient,MockTransportFactory,parseStatus}=require('../dist');
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log(`PASS ${name}`);};
const status=(...loop)=>['board: kakute_f7_hdv','gyro_ok: yes','arm: disarmed','failsafe: ok','loop: gyro=8000 Hz denom=2 cascade=4000 bg=4000',...loop].join('\r\n')+'\r\n';
const values=raw=>loopRateView(parseLoopStatus(raw)).items.map(i=>i.value);
async function main(){
 await test('frozen keys are shown exactly as sent',()=>{
  const p=parseLoopStatus(status('loop_target_hz: 4000','loop_actual_hz: 3998','loop_overruns: 12'));
  assert.deepEqual([p.targetHz,p.actualHz,p.overruns],['4000','3998','12']);
  assert.equal(p.olderFirmware,false);assert.deepEqual(values(status('loop_target_hz: 4000','loop_actual_hz: 3998','loop_overruns: 12')),['4000','3998','12']);
  assert.deepEqual(values(status('loop_target_hz: 1000','loop_actual_hz: 0','loop_overruns: 0')),['1000','0','0'],'a real 0 Hz reading after a stall is shown');
 });
 await test('missing keys and literal unavailable are unknown, never 0 and never the target',()=>{
  const older=parseLoopStatus(status());
  assert.equal(older.olderFirmware,true);assert.deepEqual(values(status()),['unknown','unknown','unknown']);
  assert.match(loopRateView(older).notice,/older FC/);
  const un=parseLoopStatus(status('loop_target_hz: 4000','loop_actual_hz: unavailable','loop_overruns: 0'));
  assert.equal(un.actualHz,null);assert.equal(un.state.loop_actual_hz,'unavailable');
  const v=loopRateView(un).items;assert.equal(v[1].value,'unknown');assert.notEqual(v[1].value,v[0].value);assert.notEqual(v[1].value,'0');
  assert.deepEqual(values(status('loop_target_hz: 4000','loop_overruns: 3')),['4000','unknown','3'],'only actual missing');
  assert.deepEqual(values(status('loop_actual_hz: 3998')),['unknown','3998','unknown'],'target never inferred from loop: gyro/denom');
  for(const k of ['loop_target_hz','loop_overruns'])assert.equal(parseLoopStatus(status(`${k}: unavailable`)).state[k],'malformed','unavailable is only a loop_actual_hz token');
  assert.equal(loopRateView(null).items.every(i=>i.value==='unknown'),true);
 });
 await test('malformed, duplicated and non-canonical values are unknown',()=>{
  for(const bad of ['','-1','4000.0','04000',' 4 000','4e3','0x10','4294967296','4000Hz'])
   assert.equal(parseLoopStatus(status(`loop_target_hz: ${bad}`)).targetHz,null,`target ${JSON.stringify(bad)}`);
  assert.equal(parseLoopStatus(status('loop_target_hz: 0')).targetHz,null,'a 0 target is not meaningful');
  assert.equal(parseLoopStatus(status('loop_actual_hz: 4294967295')).actualHz,'4294967295');
  const dup=parseLoopStatus(status('loop_target_hz: 4000','loop_target_hz: 1000','loop_actual_hz: 999','loop_overruns: 1','loop_overruns: 1'));
  assert.equal(dup.targetHz,null);assert.equal(dup.overruns,null);assert.equal(dup.actualHz,'999');
  assert.equal(dup.state.loop_target_hz,'duplicate');assert.match(loopRateView(dup).notice,/missing or malformed/);
  assert.equal(parseLoopStatus('loop_target_hz:4000\nloop_actual_hz:  3998  \n').targetHz,'4000','CRLF/LF and spacing tolerated');
 });
 await test('loop_overruns is a uint64 digit string with no Number() precision loss',()=>{
  const big='9007199254740993';assert.notEqual(String(Number(big)),big,'fixture really exceeds 2^53');
  assert.equal(parseLoopStatus(status(`loop_overruns: ${big}`)).overruns,big);
  assert.equal(parseLoopStatus(status('loop_overruns: 18446744073709551615')).overruns,'18446744073709551615');
  assert.equal(parseLoopStatus(status('loop_overruns: 18446744073709551616')).overruns,null,'above UINT64_MAX');
  assert.equal(parseLoopStatus(status('loop_overruns: 007')).overruns,null,'leading zeros are not the FW format');
  assert.equal(parseUint64('0'),'0');assert.equal(parseUint64(undefined),null);
 });
 await test('labels: actual is the last ~1 s window, never since boot',()=>{
  assert.equal(LOOP_LABELS.actual,'Loop actual (Hz, last ~1 s)');assert.doesNotMatch(LOOP_LABELS.actual,/boot/i);
  assert.equal(LOOP_LABELS.target,'Loop target (Hz)');assert.equal(LOOP_LABELS.overruns,'Loop overruns (since boot)');
 });
 await test('mock status scenarios 1000/1, 8000/2, 8000/1, 8000/1-guard, 1000/1-no8k, bidir fixtures, unavailable and missing over the real client',async()=>{
  const expected={'missing':['unknown','unknown','unknown'],'1000/1':['1000','999','1'],'8000/2':['4000','3998','9007199254740993'],'unavailable':['4000','unknown','0'],'8000/1':['8000','7996','4'],'8000/1-guard':['4000','4000','16384'],'1000/1-no8k':['1000','1000','0'],
   'bidir-4k':['4000','3999','2'],'bidir-8k-capped':['4000','3997','3'],'bidir-capture-failed':['1000','1000','0'],'bidir-older-fc':['1000','1000','0'],'reason-missing':['4000','3999','2']};
  assert.deepEqual(Object.keys(expected).sort(),[...LOOP_RATE_MOCK_SCENARIOS].sort());
  for(const scenario of LOOP_RATE_MOCK_SCENARIOS){
   const client=new BobFlightCliClient(new MockTransportFactory(scenario==='missing'?undefined:{loopRateScenario:scenario}));
   await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
   const raw=await client.sendCommand('status');
   assert.deepEqual(values(raw),expected[scenario],scenario);
   const legacy=parseStatus(raw);assert.equal(typeof legacy.loop,'string',`${scenario}: old loop line still parsed`);
   assert.ok(raw.includes(mockLoopStatusLines(scenario)[0]));
   await client.disconnect();
  }
 });
 console.log(`PASS loop-rate protocol: ${passed} tests`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
