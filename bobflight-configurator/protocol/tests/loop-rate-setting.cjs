/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * loop_rate_hz setting: reply parsers, view model, allowlist and MockSerial get/set/loop_rate/reboot over the real client. */
const assert=require('node:assert/strict');
const {LOOP_RATE_OPTIONS,LOOP_RATE_OPTION_LABELS,LOOP_RATE_SETTING_KEY,isLoopRateCliCommand,loopRateSetCommand,parseLoopRateGetReply,parseLoopRateSetReply,parseLoopRateReport,loopRateSettingView,
  parseLoopStatus,MockLoopRateSetting,mockLoopRateBootSetting,LOOP_RATE_MOCK_SCENARIOS,BobFlightCliClient,MockTransportFactory}=require('../dist');
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log(`PASS ${name}`);};
const NOTE='note: loop_rate_hz takes effect after save + reboot';
const report=(o={})=>['loop_rate_api: 1',`loop_rate_setting_hz: ${o.setting??'4000'}`,`loop_rate_boot_setting_hz: ${o.boot??'4000'}`,`loop_rate_pending_reboot: ${o.pending??'0'}`,
  `loop_rate_profile: ${o.profile??'8000/2'}`,`loop_rate_active: ${o.active??'8000/2'}`,`loop_rate_reason: ${o.reason??'setting'}`,'loop_rate_guard_level: 0','loop_rate_gyro_odr_hz: 8000','loop_rate_gyro_spi_hz: 13500000','loop_rate_end: 1'].join('\r\n')+'\r\n';
async function main(){
 await test('options are exactly 1000|4000|8000 with 1k/4k/8k labels',()=>{
  assert.deepEqual([...LOOP_RATE_OPTIONS],['1000','4000','8000']);assert.equal(LOOP_RATE_SETTING_KEY,'loop_rate_hz');
  assert.deepEqual(Object.values(LOOP_RATE_OPTION_LABELS),['1 kHz','4 kHz','8 kHz']);
  for(const v of LOOP_RATE_OPTIONS)assert.equal(loopRateSetCommand(v),`set loop_rate_hz ${v}`);
  for(const bad of ['2000','4000.0','','8000 ',4000])assert.throws(()=>loopRateSetCommand(bad));
  for(const c of ['get loop_rate_hz','set loop_rate_hz 1000','set loop_rate_hz 4000','set loop_rate_hz 8000','loop_rate'])assert.ok(isLoopRateCliCommand(c),c);
  for(const c of ['set loop_rate_hz 2000','set loop_rate_hz 4000\nsave','set loop_rate_hz','get loop_rate'])assert.ok(!isLoopRateCliCommand(c),c);
 });
 await test('get reply: value, older FC (unknown key) and malformed',()=>{
  assert.deepEqual(parseLoopRateGetReply('loop_rate_hz=4000\r\n'),{kind:'value',value:'4000'});
  assert.deepEqual(parseLoopRateGetReply('unknown key\r\n'),{kind:'unsupported'});
  for(const bad of ['loop_rate_hz=2000','loop_rate_hz=4000.0','loop_rate_hz=04000','loop_rate_hz=4000\r\nloop_rate_hz=8000','','unknown — try help'])
   assert.equal(parseLoopRateGetReply(bad).kind,'malformed',JSON.stringify(bad));
 });
 await test('set reply: accepted only when echoed exactly, with the save + reboot note',()=>{
  assert.deepEqual(parseLoopRateSetReply(`ok loop_rate_hz=8000\r\n${NOTE}\r\n`,'8000'),{ok:true,value:'8000',rebootRequired:true});
  assert.equal(parseLoopRateSetReply('ok loop_rate_hz=4000\r\n','8000').ok,false,'echo must match the request');
  assert.equal(parseLoopRateSetReply(`ok loop_rate_hz=8000\r\n${NOTE}\r\nsaved\r\n`,'8000').ok,false,'no extra lines');
  assert.equal(parseLoopRateSetReply('set failed: loop_rate_hz must be 1000, 4000 or 8000\r\n','4000').reason,'invalid');
  const board=parseLoopRateSetReply('set failed: loop_rate_hz 8000 not supported on tmotor_f7_v2 (no 8 kHz gyro path)\r\n','8000');
  assert.equal(board.reason,'unsupported-board');assert.match(board.message,/tmotor_f7_v2 \(no 8 kHz gyro path\)/);
  assert.equal(parseLoopRateSetReply('set failed: armed\r\n','1000').reason,'armed');
  assert.equal(parseLoopRateSetReply('unknown key\r\n','1000').reason,'unknown-key');
  assert.equal(parseLoopRateSetReply('',"1000").reason,'unexpected');
 });
 await test('loop_rate report: framed, strict per-key, unknown when absent',()=>{
  const r=parseLoopRateReport(report({setting:'8000',pending:'1'}));
  assert.deepEqual(r,{settingHz:'8000',bootSettingHz:'4000',pendingReboot:true,profile:'8000/2',active:'8000/2',reason:'setting',guardLevel:'0'});
  assert.equal(parseLoopRateReport(report().replace('loop_rate_end: 1\r\n','')),null,'unterminated');
  const old=parseLoopRateReport('loop_rate_api: 1\r\nloop_rate_profile: 8000/2\r\nloop_rate_active: 8000/2\r\nloop_rate_reason: board-profile\r\nloop_rate_end: 1\r\n');
  assert.equal(old.settingHz,null);assert.equal(old.pendingReboot,null);assert.equal(old.reason,'board-profile');
  assert.equal(parseLoopRateReport(report()+report().replace('loop_rate_api: 1\r\n','')).settingHz,null,'duplicate key is unknown');
  assert.equal(parseLoopRateReport(report({pending:'2'})).pendingReboot,null);
 });
 await test('view: unknown for older FC, reboot needed, pending, and an applied rate that differs from the setting',()=>{
  const older=loopRateSettingView({kind:'unsupported'},null,'1000');
  assert.equal(older.display,'unknown');assert.equal(older.selected,null);assert.equal(older.supported,false);assert.match(older.notices.join(' '),/older FC/);
  const none=loopRateSettingView(null,null,null);assert.equal(none.display,'unknown');assert.equal(none.supported,null);
  const ok=loopRateSettingView({kind:'value',value:'4000'},parseLoopRateReport(report()),'4000');
  assert.equal(ok.display,'4 kHz');assert.equal(ok.pendingReboot,false);assert.match(ok.notices.join(' '),/takes effect after Save \+ reboot/);
  assert.doesNotMatch(ok.notices.join(' '),/instead of|fallback|Pending/);
  const pend=loopRateSettingView({kind:'value',value:'8000'},parseLoopRateReport(report({setting:'8000',pending:'1'})),'4000');
  assert.equal(pend.pendingReboot,true);assert.match(pend.notices.join(' '),/Pending: 8 kHz is selected; the controller runs its boot setting \(4 kHz\)/);
  assert.doesNotMatch(pend.notices.join(' '),/instead of/,'a pending change is not reported as a fallback');
  const guard=loopRateSettingView({kind:'value',value:'8000'},parseLoopRateReport(report({setting:'8000',boot:'8000',profile:'8000/1',active:'8000/2',reason:'overrun-guard'})),'4000');
  assert.match(guard.notices.join(' '),/running 4000 Hz instead of the selected 8000 Hz \(overrun-guard\)/);
  const bidir=loopRateSettingView({kind:'value',value:'4000'},parseLoopRateReport(report({active:'1000/1',reason:'dshot-bidir-polled-listen'})),'1000');
  assert.match(bidir.notices.join(' '),/running 1000 Hz instead of the selected 4000 Hz \(dshot-bidir-polled-listen\)/);
  const noTarget=loopRateSettingView({kind:'value',value:'4000'},parseLoopRateReport(report({active:'1000/1',reason:'no-high-res-timebase'})),null);
  assert.match(noTarget.notices.join(' '),/fallback: no-high-res-timebase/,'without a status target the reason is still shown');
 });
 await test('MockLoopRateSetting follows the FW wire and boots the saved value',()=>{
  let scenario='8000/2';const m=new MockLoopRateSetting(()=>scenario);
  assert.equal(m.handle('get loop_rate_hz',false),'loop_rate_hz=4000\r\n');
  assert.equal(m.handle('set loop_rate_hz 8000',true),'set failed: armed\r\n');
  assert.equal(m.handle('set loop_rate_hz 2000',false),'set failed: loop_rate_hz must be 1000, 4000 or 8000\r\n');
  assert.equal(m.handle('set loop_rate_hz 8000',false),`ok loop_rate_hz=8000\r\n${NOTE}\r\n`);
  assert.equal(parseLoopRateReport(m.handle('loop_rate',false)).pendingReboot,true);
  scenario=m.reboot();assert.equal(scenario,'8000/1');assert.equal(parseLoopRateReport(m.handle('loop_rate',false)).pendingReboot,false);
  m.defaults();assert.equal(m.handle('get loop_rate_hz',false),'loop_rate_hz=4000\r\n');
  scenario='missing';assert.equal(m.handle('get loop_rate_hz',false),'unknown key\r\n');assert.equal(m.handle('set loop_rate_hz 1000',false),'unknown key\r\n');
  assert.match(m.handle('loop_rate',false),/^unknown/);assert.equal(m.handle('status',false),null);
  assert.deepEqual(LOOP_RATE_MOCK_SCENARIOS.map(mockLoopRateBootSetting),[null,'1000','4000','4000','8000','8000']);
 });
 await test('real client over MockSerial: get/set/loop_rate per scenario, framed loop_rate, reboot needed',async()=>{
  const want={'1000/1':'1000','8000/2':'4000','unavailable':'4000','8000/1':'8000','8000/1-guard':'8000'};
  for(const scenario of LOOP_RATE_MOCK_SCENARIOS){
   const client=new BobFlightCliClient(new MockTransportFactory(scenario==='missing'?undefined:{loopRateScenario:scenario}));
   await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
   const get=parseLoopRateGetReply(await client.sendCommand('get loop_rate_hz'));
   if(scenario==='missing'){assert.equal(get.kind,'unsupported');assert.equal(parseLoopRateSetReply(await client.sendCommand('set loop_rate_hz 8000'),'8000').reason,'unknown-key');await client.disconnect();continue;}
   assert.deepEqual(get,{kind:'value',value:want[scenario]},scenario);
   const target=parseLoopStatus(await client.sendCommand('status')).targetHz;
   const rep=parseLoopRateReport(await client.sendCommand('loop_rate'));
   assert.equal(rep.bootSettingHz,want[scenario]);assert.equal(rep.pendingReboot,false);
   const view=loopRateSettingView(get,rep,target);
   assert.equal(/instead of/.test(view.notices.join(' ')),scenario==='8000/1-guard',`${scenario}: only the guard scenario runs below its setting`);
   const set=parseLoopRateSetReply(await client.sendCommand('set loop_rate_hz 1000'),'1000');assert.deepEqual(set,{ok:true,value:'1000',rebootRequired:true});
   const after=loopRateSettingView(parseLoopRateGetReply(await client.sendCommand('get loop_rate_hz')),parseLoopRateReport(await client.sendCommand('loop_rate')),target);
   assert.equal(after.pendingReboot,scenario!=='1000/1');
   await assert.rejects(client.sendCommand('set loop_rate_hz 2000'),/unsupported CLI command/);
   await assert.rejects(client.sendCommand('set loop_rate_hz 4000\nsave'),/unsupported CLI command/);
   await client.disconnect();
  }
 });
 console.log(`PASS loop-rate setting protocol: ${passed} tests`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
