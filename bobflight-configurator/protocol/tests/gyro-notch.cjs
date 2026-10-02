/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Manual gyro notches (FW schema 8): parsers, row view, write plan, allowlist,
 * SETTINGS_KEYS and the five MockSerial scenarios over the real client. */
const assert=require('node:assert/strict');
const {GYRO_NOTCH_KEYS,GYRO_NOTCH_UNKNOWN,isGyroNotchCliCommand,notchPairProblem,notchWritePlan,parseNotchGetReply,parseNotchSetReply,parseFiltersReport,notchRowView,
  MockGyroNotch,GYRO_NOTCH_MOCK_SCENARIOS,SETTINGS_KEYS,DEFAULT_SETTINGS,validateSettingValue,BobFlightCliClient,MockTransportFactory}=require('../dist');
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log(`PASS ${name}`);};
const report=(o={})=>['filters_api: 1',`filters_sample_hz: ${o.hz??'4000'}`,`gyro_notch1_active: ${o.a1??'no'}`,`gyro_notch1_reason: ${o.r1??'off'}`,
  `gyro_notch2_active: ${o.a2??'no'}`,`gyro_notch2_reason: ${o.r2??'off'}`,'filters_end: 1'].join('\r\n')+'\r\n';
const val=v=>({kind:'value',value:v});
async function main(){
 await test('SETTINGS_KEYS carries all 4 notch keys (default 0, single-value domain)',()=>{
  assert.deepEqual([...GYRO_NOTCH_KEYS],['gyro_notch1_hz','gyro_notch1_cutoff_hz','gyro_notch2_hz','gyro_notch2_cutoff_hz']);
  for(const k of GYRO_NOTCH_KEYS){assert.ok(SETTINGS_KEYS.includes(k),k);}
  for(const k of ['gyro_notch1_hz','gyro_notch2_hz']){for(const v of [0,20,200,1000])assert.ok(validateSettingValue(k,v),`${k} ${v}`);for(const v of [-1,10,19.9,1000.5,NaN])assert.ok(!validateSettingValue(k,v),`${k} ${v}`);}
  for(const k of ['gyro_notch1_cutoff_hz','gyro_notch2_cutoff_hz']){for(const v of [0,1,999.9])assert.ok(validateSettingValue(k,v));for(const v of [-0.1,1000,NaN])assert.ok(!validateSettingValue(k,v));}
 });
 await test('pair rule mirror (hint only): centre 0 or 20..1000, 0 < cutoff < centre',()=>{
  assert.equal(notchPairProblem(0,0),null);assert.equal(notchPairProblem(0,150),null,'off keeps any stored cutoff');
  assert.equal(notchPairProblem(200,150),null);assert.equal(notchPairProblem(1000,999),null);
  for(const [c,f] of [[10,5],[1001,500],[200,200],[200,0],[200,250],[0,1000],[0,-1]])assert.ok(notchPairProblem(c,f),`${c}/${f}`);
  // No Nyquist math client-side: 1000 Hz is fine here, only the FC decides against its loop rate.
  assert.equal(notchPairProblem(600,420),null);
 });
 await test('write plan: every intermediate pair valid; enabled notch only switched off when needed',()=>{
  const step=(pair,s)=>s.key.endsWith('cutoff_hz')?{...pair,cutoff:s.value}:{...pair,center:s.value};
  const cases=[[{center:0,cutoff:0},{center:200,cutoff:150}],[{center:200,cutoff:150},{center:0,cutoff:150}],[{center:200,cutoff:150},{center:300,cutoff:250}],
   [{center:300,cutoff:250},{center:200,cutoff:150}],[{center:200,cutoff:150},{center:200,cutoff:100}],[{center:200,cutoff:150},{center:500,cutoff:150}],
   [{center:600,cutoff:420},{center:440,cutoff:420}],[{center:600,cutoff:420},{center:300,cutoff:250}],[{center:100,cutoff:50},{center:900,cutoff:800}],[{center:900,cutoff:800},{center:100,cutoff:50}],[null,{center:200,cutoff:150}],[{center:0,cutoff:150},{center:0,cutoff:0}]];
  for(const [cur,next] of cases){
   const plan=notchWritePlan(1,cur,next);let p=cur??{center:NaN,cutoff:NaN};
   for(const s of plan){p=step(p,s);if(Number.isFinite(p.center)&&Number.isFinite(p.cutoff))assert.equal(notchPairProblem(p.center,p.cutoff),null,`${JSON.stringify(cur)}->${JSON.stringify(next)} via ${JSON.stringify(p)}`);}
   assert.deepEqual(p,next);
   if(cur&&cur.center!==0&&next.center!==0)assert.ok(!plan.some(s=>s.key==='gyro_notch1_hz'&&s.value===0),'no off step between two enabled pairs');
  }
  assert.deepEqual(notchWritePlan(2,{center:200,cutoff:150},{center:200,cutoff:150}),[]);
  assert.deepEqual(notchWritePlan(2,null,{center:200,cutoff:150}).map(s=>s.key),['gyro_notch2_hz','gyro_notch2_cutoff_hz','gyro_notch2_hz']);
  assert.deepEqual(notchWritePlan(1,{center:600,cutoff:420},{center:500,cutoff:420}),[{key:'gyro_notch1_hz',value:500}],'centre-only change is one set');
 });
 await test('allowlist: exact notch lines only',()=>{
  for(const c of ['filters','get gyro_notch1_hz','get gyro_notch2_cutoff_hz','set gyro_notch1_hz 0','set gyro_notch1_hz 200','set gyro_notch2_cutoff_hz 150.5'])assert.ok(isGyroNotchCliCommand(c),c);
  for(const c of ['set gyro_notch3_hz 200','set gyro_notch1_hz -1','set gyro_notch1_hz 1e3','set gyro_notch1_hz 200\nsave','get gyro_notch1','filters x'])assert.ok(!isGyroNotchCliCommand(c),c);
 });
 await test('get/set replies: value strings verbatim, older FC, FW refusal line verbatim',()=>{
  assert.deepEqual(parseNotchGetReply('gyro_notch1_hz=200\r\n','gyro_notch1_hz'),val('200'));
  assert.deepEqual(parseNotchGetReply('gyro_notch1_cutoff_hz=149.5\r\n','gyro_notch1_cutoff_hz'),val('149.5'));
  assert.deepEqual(parseNotchGetReply('unknown key\r\n','gyro_notch1_hz'),{kind:'unsupported'});
  for(const bad of ['gyro_notch2_hz=200','gyro_notch1_hz=abc','','gyro_notch1_hz=1\r\ngyro_notch1_hz=2'])assert.equal(parseNotchGetReply(bad,'gyro_notch1_hz').kind,'malformed',bad);
  assert.deepEqual(parseNotchSetReply('ok gyro_notch1_hz=200\r\n','gyro_notch1_hz'),{ok:true,value:'200'});
  const line='set failed: gyro_notch1_hz must be below 450 Hz at the running 1000 Hz loop rate';
  assert.deepEqual(parseNotchSetReply(line+'\r\n','gyro_notch1_hz'),{ok:false,unsupported:false,message:line});
  assert.equal(parseNotchSetReply('unknown key\r\n','gyro_notch1_hz').unsupported,true);
 });
 await test('filters report: exact shape, unknown tokens kept verbatim, missing/dup = unknown',()=>{
  const r=parseFiltersReport(report({hz:'1000',a1:'no',r1:'above-nyquist'}));
  assert.deepEqual(r,{kind:'report',report:{sampleHz:'1000',notches:{1:{active:'no',reason:'above-nyquist'},2:{active:'no',reason:'off'}}}});
  const odd=parseFiltersReport(report({r1:'guard-fallback',a1:'maybe'}));
  assert.equal(odd.report.notches[1].reason,'guard-fallback','unknown reason token shown as-is, never mapped to ok');
  assert.equal(odd.report.notches[1].active,'maybe');
  const dup=parseFiltersReport(report().replace('filters_end: 1','gyro_notch2_reason: ok\r\nfilters_end: 1'));
  assert.equal(dup.report.notches[2].reason,null);
  const miss=parseFiltersReport(report().replace(/gyro_notch1_reason: off\r\n/,''));
  assert.equal(miss.report.notches[1].reason,null);
  assert.deepEqual(parseFiltersReport('unknown — try help\r\n'),{kind:'unsupported'});
  assert.equal(parseFiltersReport('filters_api: 1\r\n').kind,'malformed');
 });
 await test('row view: off keeps the cutoff, older FC is unknown (never 0/off), tokens verbatim',()=>{
  const rep=parseFiltersReport(report({r1:'guard-fallback'}));
  const off=notchRowView(1,val('0'),val('150'),rep);
  assert.equal(off.off,true);assert.equal(off.cutoffDisabled,true);assert.equal(off.cutoff,'150','stored cutoff kept while off');
  assert.equal(off.reason,'guard-fallback');
  const on=notchRowView(2,val('200'),val('150'),parseFiltersReport(report({a2:'yes',r2:'ok'})));
  assert.deepEqual([on.off,on.cutoffDisabled,on.active,on.reason,on.center,on.cutoff],[false,false,'yes','ok','200','150']);
  for(const [c,f] of [[{kind:'unsupported'},{kind:'unsupported'}],[null,null],[val('200'),{kind:'unsupported'}]]){
   const v=notchRowView(1,c,f,rep);
   assert.equal(v.supported,false);assert.equal(v.cutoffDisabled,true);assert.equal(v.off,null);
   for(const k of ['center','cutoff','active','reason'])assert.equal(v[k],GYRO_NOTCH_UNKNOWN,k);
  }
  const noReport=notchRowView(1,val('200'),val('150'),null);
  assert.equal(noReport.active,GYRO_NOTCH_UNKNOWN);assert.equal(noReport.reason,GYRO_NOTCH_UNKNOWN);
 });
 await test('MockGyroNotch: five scenarios produce the FW report shape',()=>{
  assert.deepEqual([...GYRO_NOTCH_MOCK_SCENARIOS],['off','ok','above-nyquist','invalid','old-fc']);
  const exp={off:['8000','no','off'],ok:['8000','yes','ok'],'above-nyquist':['1000','no','above-nyquist'],invalid:['8000','no','invalid']}; // S1: filter rate = gyro rate
  for(const [s,[hz,a,r]] of Object.entries(exp)){
   const m=new MockGyroNotch(s);const rep=parseFiltersReport(m.handle('filters',false));
   assert.equal(rep.report.sampleHz,hz,s);assert.deepEqual(rep.report.notches[1],{active:a,reason:r},s);assert.deepEqual(rep.report.notches[2],{active:'no',reason:'off'},s);
  }
  assert.equal(new MockGyroNotch('above-nyquist').handle('get gyro_notch1_hz',false),'gyro_notch1_hz=600\r\n','600 Hz notch stored');
  const old=new MockGyroNotch('old-fc');
  assert.equal(old.handle('filters',false),'unknown — try help\r\n');assert.equal(old.handle('get gyro_notch1_hz',false),'unknown key\r\n');assert.equal(old.handle('set gyro_notch1_hz 0',false),'unknown key\r\n');
 });
 await test('MockGyroNotch: FW-identical refusals leave the value unchanged',()=>{
  const m=new MockGyroNotch('above-nyquist');
  const cases=[['set gyro_notch1_hz 500','set failed: gyro_notch1_hz must be below 450 Hz at the running 1000 Hz loop rate'],['set gyro_notch1_hz 10','set failed: gyro_notch1_hz must be 0 or 20..1000'],
   ['set gyro_notch1_cutoff_hz 700','set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz'],['set gyro_notch2_hz 200','set failed: gyro_notch2_hz needs 0 < gyro_notch2_cutoff_hz < gyro_notch2_hz (set the cutoff first)'],
   ['set gyro_notch2_cutoff_hz 1000','set failed: gyro_notch2_cutoff_hz must be >= 0 and < 1000 while gyro_notch2_hz is 0'],['set gyro_notch1_hz abc','set failed']];
  for(const [cmd,line] of cases){const before=m.snapshot();assert.equal(m.handle(cmd,false),line+'\r\n',cmd);assert.deepEqual(m.snapshot(),before,cmd);}
  assert.equal(m.handle('set gyro_notch1_hz 0',true),'set failed: armed\r\n');
 });
 await test('real client over MockSerial: all five scenarios, set re-read with get, refused set verbatim',async()=>{
  const paths={off:'mock://bobflight',ok:'mock://bobflight-notch-ok','above-nyquist':'mock://bobflight-notch-nyquist',invalid:'mock://bobflight-notch-invalid','old-fc':'mock://bobflight-notch-old'};
  for(const [s,path] of Object.entries(paths)){
   const client=new BobFlightCliClient(new MockTransportFactory());
   await client.connect({path,transport:'mock'});await new Promise(r=>setTimeout(r,15));
   const all=await client.getAllSettings();
   if(s==='old-fc'){
    for(const k of GYRO_NOTCH_KEYS)assert.equal(all[k],undefined,`old FC omits ${k} (never 0)`);
    assert.equal(parseFiltersReport(await client.sendCommand('filters')).kind,'unsupported');
    await assert.rejects(client.getSetting('gyro_notch1_hz'),/unknown key/);
    await client.disconnect();continue;
   }
   for(const k of GYRO_NOTCH_KEYS)assert.equal(typeof all[k],'string',k);
   const rep=parseFiltersReport(await client.sendCommand('filters'));
   assert.equal(rep.kind,'report',s);
   if(s==='above-nyquist'){
    assert.equal(all.gyro_notch1_hz,'600');assert.equal(rep.report.notches[1].reason,'above-nyquist');assert.equal(rep.report.sampleHz,'1000');
    const line='set failed: gyro_notch1_hz must be below 450 Hz at the running 1000 Hz loop rate';
    await assert.rejects(client.setSetting('gyro_notch1_hz','500'),e=>e.message===line);
    assert.deepEqual(await client.getSetting('gyro_notch1_hz'),{key:'gyro_notch1_hz',value:'600'},'refused set leaves the value unchanged');
   }
   if(s==='off'){
    await client.setSetting('gyro_notch2_cutoff_hz','150');await client.setSetting('gyro_notch2_hz','200');
    assert.equal((await client.getSetting('gyro_notch2_hz')).value,'200');
    assert.equal(parseFiltersReport(await client.sendCommand('filters')).report.notches[2].reason,'ok');
   }
   await client.disconnect();
  }
 });
 await test('N1: no reason line at sample 1000 with centre 600 is unknown (never inferred from filters_sample_hz)',()=>{
  const noReason=['filters_api: 1','filters_sample_hz: 1000','gyro_notch1_active: no','gyro_notch2_active: no','gyro_notch2_reason: off','filters_end: 1'].join('\r\n')+'\r\n';
  const rep=parseFiltersReport(noReason);
  assert.equal(rep.kind,'report');assert.equal(rep.report.sampleHz,'1000');assert.equal(rep.report.notches[1].reason,null);
  const v=notchRowView(1,val('600'),val('420'),rep);
  assert.equal(v.reason,GYRO_NOTCH_UNKNOWN,'reason missing: unknown, not above-nyquist');
  assert.equal(v.active,'no','active kept verbatim');
  assert.deepEqual([v.center,v.cutoff],['600','420']);
  // Same values with every sample rate: the row never changes its reason on its own.
  for(const hz of ['1000','4000','8000','500']){
   const r=parseFiltersReport(noReason.replace('filters_sample_hz: 1000',`filters_sample_hz: ${hz}`));
   assert.equal(notchRowView(1,val('600'),val('420'),r).reason,GYRO_NOTCH_UNKNOWN,hz);
  }
  // Active missing too: both unknown.
  const bare=parseFiltersReport(['filters_api: 1','filters_sample_hz: 1000','filters_end: 1'].join('\r\n'));
  const b=notchRowView(1,val('600'),val('420'),bare);
  assert.deepEqual([b.active,b.reason],[GYRO_NOTCH_UNKNOWN,GYRO_NOTCH_UNKNOWN]);
 });
 await test('V3: a malformed token ("above nyquist", with a space) is unknown; a well-formed unknown token stays verbatim',()=>{
  const rep=parseFiltersReport(report({hz:'1000',r1:'above nyquist',a1:'no'}));
  assert.equal(rep.kind,'report');assert.equal(rep.report.notches[1].reason,null,'not one \\S+ token');
  assert.equal(notchRowView(1,val('600'),val('420'),rep).reason,GYRO_NOTCH_UNKNOWN);
  assert.equal(notchRowView(1,val('200'),val('150'),parseFiltersReport(report({a1:'yes please'}))).active,GYRO_NOTCH_UNKNOWN,'active with a space: unknown');
  const odd=parseFiltersReport(report({r1:'guard-fallback'}));
  assert.equal(notchRowView(1,val('200'),val('150'),odd).reason,'guard-fallback','unknown future token shown as sent');
 });
 for(const k of GYRO_NOTCH_KEYS)assert.equal(DEFAULT_SETTINGS[k],"0",k);
 console.log(`gyro-notch: ${passed} passed`);
}
main().catch(e=>{console.error(e);process.exit(1);});
