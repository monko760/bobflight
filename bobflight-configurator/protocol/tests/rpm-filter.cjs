/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * RPM notch filter (FW schema 9): parsers, view model, Q conversion,
 * allowlist, SETTINGS_KEYS and the MockSerial scenarios over the real client. */
const assert=require('node:assert/strict');
const {RPM_FILTER_KEYS,RPM_FILTER_UNKNOWN,RPM_FILTER_REASONS,RPM_FILTER_REPORT_FIELDS,rpmFilterReportIsExact,isRpmFilterCliCommand,rpmValueProblem,qFromX100,qToX100,parseRpmGetReply,parseRpmSetReply,parseRpmFilterReport,rpmFilterView,
  MockRpmFilter,RPM_FILTER_MOCK_SCENARIOS,SETTINGS_KEYS,DEFAULT_SETTINGS,validateSettingValue,BobFlightCliClient,MockTransportFactory}=require('../dist');
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log(`PASS ${name}`);};
const val=v=>({kind:'value',value:v});
const report=(o={})=>['rpm_filter_api: 1',`rpm_filter_active: ${o.active??'yes'}`,`rpm_filter_reason: ${o.reason??'ok'}`,`rpm_filter_sample_hz: ${o.hz??'4000'}`,
  `rpm_filter_harmonics_active: ${o.run??'3'}`,...[1,2,3,4].map(m=>`rpm_filter_m${m}_hz: ${o.m?.[m-1]??'180'}`),'rpm_filter_end: 1'].join('\r\n')+'\r\n';
const values=(o={})=>({rpm_filter_harmonics:val(o.h??'3'),rpm_filter_min_hz:val(o.min??'100'),rpm_filter_q_x100:val(o.q??'500'),motor_poles:val(o.p??'14')});
async function main(){
 await test('SETTINGS_KEYS carries the 4 schema 9 keys with FW defaults and integer domains',()=>{
  assert.deepEqual([...RPM_FILTER_KEYS],['rpm_filter_harmonics','rpm_filter_min_hz','rpm_filter_q_x100','motor_poles']);
  for(const k of RPM_FILTER_KEYS)assert.ok(SETTINGS_KEYS.includes(k),k);
  assert.deepEqual(RPM_FILTER_KEYS.map(k=>DEFAULT_SETTINGS[k]),['0','100','500','14']);
  const dom={rpm_filter_harmonics:[[0,1,3],[-1,4,1.5]],rpm_filter_min_hz:[[50,120,200],[49,201,100.5]],rpm_filter_q_x100:[[100,350,1000],[99,1001,500.5]],motor_poles:[[4,14,36],[2,13,38,15.9]]};
  for(const [k,[good,bad]] of Object.entries(dom)){for(const v of good){assert.ok(validateSettingValue(k,v),`${k} ${v}`);assert.equal(rpmValueProblem(k,v),null);}for(const v of [...bad,NaN]){assert.ok(!validateSettingValue(k,v),`${k} ${v}`);assert.ok(rpmValueProblem(k,v),`${k} ${v}`);}}
  assert.deepEqual([...RPM_FILTER_REASONS],['off','bidir-off','erpm-unavailable','ok']);
 });
 await test('Q: shown /100 exactly, sent x100 as an integer (at most two decimals)',()=>{
  for(const [x,q] of [['500','5'],['350','3.5'],['125','1.25'],['100','1'],['1000','10'],['101','1.01']])assert.equal(qFromX100(x),q,x);
  for(const [q,x] of [['5',500],['3.5',350],['1.25',125],['10',1000],[' 2.50 ',250]])assert.equal(qToX100(q),x,q);
  for(const q of ['1.255','abc','','-1','5e2','100'])assert.equal(qToX100(q),null,q);
  for(const x of ['350.5','abc','','-5','5e2'])assert.equal(qFromX100(x),RPM_FILTER_UNKNOWN,`${x}: not a whole number -> unknown (nit 10)`);
  assert.equal(rpmFilterView(values({q:'350.5'}),parseRpmFilterReport(report())).q,RPM_FILTER_UNKNOWN,'view: q_x100 350.5 -> Q unknown');
 });
 await test('allowlist: exact RPM lines only, plain whole numbers',()=>{
  for(const c of ['rpm_filter','get rpm_filter_harmonics','get rpm_filter_min_hz','get rpm_filter_q_x100','get motor_poles','set rpm_filter_harmonics 0','set rpm_filter_q_x100 350','set motor_poles 14','set rpm_filter_min_hz 9999'])assert.ok(isRpmFilterCliCommand(c),c);
  for(const c of ['set rpm_filter_harmonics -1','set rpm_filter_q_x100 3.5','set motor_poles 1e1','set motor_poles 014','set rpm_filter_min_hz 10000','set rpm_filter_harmonics 1\nsave','get erpm_m1','rpm_filter x','get rpm_filter_m1_hz','set dshot_bidir on'])assert.ok(!isRpmFilterCliCommand(c),c);
 });
 await test('get/set replies: values verbatim, older FC, FW refusal line verbatim',()=>{
  assert.deepEqual(parseRpmGetReply('rpm_filter_q_x100=350\r\n','rpm_filter_q_x100'),val('350'));
  assert.deepEqual(parseRpmGetReply('unknown key\r\n','motor_poles'),{kind:'unsupported'});
  for(const bad of ['motor_poles=14','rpm_filter_harmonics=abc','','rpm_filter_harmonics=1\r\nrpm_filter_harmonics=2'])assert.equal(parseRpmGetReply(bad,'rpm_filter_harmonics').kind,'malformed',bad);
  assert.deepEqual(parseRpmSetReply('ok motor_poles=12\r\n','motor_poles'),{ok:true,value:'12'});
  for(const line of ['set failed: rpm_filter_harmonics must be 0..3','set failed: motor_poles must be even, 4..36','set failed: armed','set failed'])
   assert.deepEqual(parseRpmSetReply(line+'\r\n','rpm_filter_harmonics'),{ok:false,unsupported:false,message:line});
  assert.equal(parseRpmSetReply('ok motor_poles=12\r\n','rpm_filter_harmonics').ok,false,'echo of another key is not ok');
  assert.equal(parseRpmSetReply('unknown key\r\n','motor_poles').unsupported,true);
 });
 await test('report: exact fields, unknown tokens verbatim, malformed/missing/duplicate = null',()=>{
  const r=parseRpmFilterReport(report({hz:'1000',run:'1',m:['180','unavailable','179','185']}));
  assert.deepEqual(r,{kind:'report',report:{active:'yes',reason:'ok',sampleHz:'1000',harmonicsActive:'1',motorHz:{1:'180',2:'unavailable',3:'179',4:'185'}}});
  assert.equal(parseRpmFilterReport(report({reason:'esc-fallback'})).report.reason,'esc-fallback','unknown token kept, never mapped');
  assert.equal(parseRpmFilterReport(report({reason:'bidir off'})).report.reason,null,'two words: not one \\S+ token');
  assert.equal(parseRpmFilterReport(report({active:'yes please'})).report.active,null);
  assert.equal(parseRpmFilterReport(report().replace('rpm_filter_end: 1','rpm_filter_reason: off\r\nrpm_filter_end: 1')).report.reason,null,'duplicate');
  assert.equal(parseRpmFilterReport(report().replace(/rpm_filter_m3_hz: 180\r\n/,'')).report.motorHz[3],null,'missing');
  assert.deepEqual(parseRpmFilterReport('unknown — try help\r\n'),{kind:'unsupported'});
  assert.equal(parseRpmFilterReport('rpm_filter_api: 1\r\n').kind,'malformed');
 });
 await test('report: numeric fields must be ^\\d+$; m1..m4 also unavailable or a lowercase token; else unknown (nit 9)',()=>{
  for(const bad of ['4OOO','-5','18.5','1e3','+5','0x10','４０００']){
   const r=parseRpmFilterReport(report({hz:bad,run:bad,m:[bad,bad,bad,bad]})).report;
   assert.deepEqual([r.sampleHz,r.harmonicsActive,...Object.values(r.motorHz)],[null,null,null,null,null,null],bad);
   const v=rpmFilterView(values(),{kind:'report',report:r});
   assert.deepEqual([v.sampleHz,v.harmonicsActive,...v.motors.map(m=>m.hz)],Array(6).fill(RPM_FILTER_UNKNOWN),`${bad} shows unknown`);
  }
  const ok=parseRpmFilterReport(report({hz:'4000',run:'0',m:['0','unavailable','esc-fallback','185']})).report;
  assert.deepEqual([ok.sampleHz,ok.harmonicsActive,...Object.values(ok.motorHz)],['4000','0','0','unavailable','esc-fallback','185'],'digits, unavailable and a lowercase future token kept verbatim');
  for(const t of ['Unavailable','UNAVAILABLE','n/a','esc_fallback','-unavailable'])assert.equal(parseRpmFilterReport(report({m:[t,'1','2','3']})).report.motorHz[1],null,t);
  assert.equal(parseRpmFilterReport(report({hz:'unavailable'})).report.sampleHz,null,'sample_hz is digits only');
  assert.equal(parseRpmFilterReport(report({reason:'esc-fallback',active:'partial'})).report.reason,'esc-fallback','reason/active tokens still verbatim');
 });
 await test('frozen report shape: exact lines and order; no rpm_filter_harmonics line (setting comes from get)',()=>{
  assert.deepEqual([...RPM_FILTER_REPORT_FIELDS],['rpm_filter_active','rpm_filter_reason','rpm_filter_sample_hz','rpm_filter_harmonics_active','rpm_filter_m1_hz','rpm_filter_m2_hz','rpm_filter_m3_hz','rpm_filter_m4_hz']);
  assert.equal(rpmFilterReportIsExact(report()),true);
  const extra=report().replace('rpm_filter_harmonics_active: 3','rpm_filter_harmonics: 3\r\nrpm_filter_harmonics_active: 3');
  assert.equal(rpmFilterReportIsExact(extra),false,'extra rpm_filter_harmonics line is not the frozen shape');
  assert.equal('harmonics' in parseRpmFilterReport(extra).report,false,'parser has no report harmonics field');
  assert.equal(rpmFilterView(values({h:'2'}),parseRpmFilterReport(extra)).harmonics,'2','harmonics shown from get, never from the report');
  const swapped=report().replace(/rpm_filter_active: yes\r\nrpm_filter_reason: ok/,'rpm_filter_reason: ok\r\nrpm_filter_active: yes');
  assert.equal(rpmFilterReportIsExact(swapped),false,'order is frozen');
  assert.equal(rpmFilterReportIsExact(report().replace(/rpm_filter_m4_hz: \S+\r\n/,'')),false,'missing line');
  assert.equal(rpmFilterReportIsExact(report({reason:'bidir off'})),false,'one token per field');
 });
 await test('view: tokens verbatim, bidirOff only for the exact token, older FC unknown (never 0/off)',()=>{
  const v=rpmFilterView(values({q:'350'}),parseRpmFilterReport(report({m:['180','182','unavailable','185']})));
  assert.deepEqual([v.supported,v.harmonics,v.minHz,v.qX100,v.q,v.motorPoles,v.sampleHz,v.harmonicsActive,v.active,v.reason,v.bidirOff],[true,'3','100','350','3.5','14','4000','3','yes','ok',false]);
  assert.deepEqual(v.motors.map(m=>m.hz),['180','182','unavailable','185']);
  assert.equal(rpmFilterView(values(),parseRpmFilterReport(report({reason:'bidir-off',active:'no',run:'0'}))).bidirOff,true);
  const weird=rpmFilterView(values(),parseRpmFilterReport(report({reason:'bidir off'})));
  assert.deepEqual([weird.reason,weird.bidirOff],[RPM_FILTER_UNKNOWN,false]);
  for(const [vals,rep] of [[{},null],[{...values(),motor_poles:{kind:'unsupported'}},parseRpmFilterReport(report())],[values(),{kind:'unsupported'}],[values(),null]]){
   const o=rpmFilterView(vals,rep);
   assert.equal(o.supported,false);
   for(const k of ['harmonics','minHz','q','motorPoles','sampleHz','harmonicsActive','active','reason'])assert.equal(o[k],RPM_FILTER_UNKNOWN,k);
   assert.ok(o.motors.every(m=>m.hz===RPM_FILTER_UNKNOWN));assert.equal(o.bidirOff,false);
  }
 });
 await test('view never computes Hz from eRPM or trims from the sample rate',()=>{
  const v=rpmFilterView(values(),parseRpmFilterReport(report({hz:'1000',run:'3',m:['unavailable','unavailable','unavailable','unavailable']})));
  assert.equal(v.harmonicsActive,'3','FC says 3 at 1 kHz: shown as sent');
  assert.ok(v.motors.every(m=>m.hz==='unavailable'));
  assert.equal(rpmFilterView.length,2,'view takes only the get results and the report (no eRPM input)');
 });
 await test('MockRpmFilter: eight scenarios produce the FW report shape',()=>{
  assert.deepEqual([...RPM_FILTER_MOCK_SCENARIOS],['off','ok','bidir-off','erpm-unavailable','trimmed-1k','old-fc','off-erpm-live','active-partial']);
  const U='unavailable',live=['180','182','179','185'];
  const exp={off:['4000','0','0','no','off',[U,U,U,U]],ok:['4000','3','3','yes','ok',live],'bidir-off':['4000','2','0','no','bidir-off',[U,U,U,U]],
   'erpm-unavailable':['4000','2','0','no','erpm-unavailable',[U,U,U,U]],'trimmed-1k':['1000','3','1','yes','ok',live],'off-erpm-live':['4000','0','0','no','off',[U,U,U,U]],
   'active-partial':['4000','3','3','yes','ok',['180',U,'179','185']]};
  for(const [s,[hz,h,run,a,r,m]] of Object.entries(exp)){
   const mock=new MockRpmFilter(s),raw=mock.handle('rpm_filter',false),rep=parseRpmFilterReport(raw).report;
   assert.ok(rpmFilterReportIsExact(raw),`${s}: mock report in the frozen shape`);
   assert.equal(mock.handle('get rpm_filter_harmonics',false),`rpm_filter_harmonics=${h}\r\n`,`${s}: harmonics via get`);
   assert.deepEqual([rep.sampleHz,rep.harmonicsActive,rep.active,rep.reason,Object.values(rep.motorHz)],[hz,run,a,r,m],s);
  }
  assert.equal(new MockRpmFilter('off-erpm-live').handle('get erpm_m1',false),'erpm_m1=75600\r\n','live eRPM while the filter is off');
  assert.equal(new MockRpmFilter('active-partial').handle('get erpm_m2',false),'erpm_m2=76440\r\n','active-partial: M2 eRPM is live, yet the FC reports m2 unavailable');
  assert.equal(new MockRpmFilter('ok').handle('get erpm_m1',false),null,'other scenarios leave eRPM to the host mock');
  const old=new MockRpmFilter('old-fc');
  assert.equal(old.handle('rpm_filter',false),'unknown — try help\r\n');assert.equal(old.handle('get motor_poles',false),'unknown key\r\n');assert.equal(old.handle('set motor_poles 14',false),'unknown key\r\n');
 });
 await test('MockRpmFilter: FW-identical refusals leave the value unchanged',()=>{
  const m=new MockRpmFilter('ok');
  const cases=[['set rpm_filter_harmonics 4','set failed: rpm_filter_harmonics must be 0..3'],['set rpm_filter_min_hz 49','set failed: rpm_filter_min_hz must be 50..200'],
   ['set rpm_filter_q_x100 1001','set failed: rpm_filter_q_x100 must be 100..1000'],['set motor_poles 13','set failed: motor_poles must be even, 4..36'],['set motor_poles 2','set failed: motor_poles must be even, 4..36'],
   ['set rpm_filter_q_x100 3.5','set failed'],['set motor_poles abc','set failed']];
  for(const [cmd,line] of cases){const before=m.snapshot();assert.equal(m.handle(cmd,false),line+'\r\n',cmd);assert.deepEqual(m.snapshot(),before,cmd);}
  assert.equal(m.handle('set motor_poles 12',true),'set failed: armed\r\n');assert.equal(m.snapshot().motor_poles,'14');
  assert.equal(m.handle('set motor_poles 12',false),'ok motor_poles=12\r\n');
 });
 await test('MockRpmFilter bidir follows the host dshot_bidir (bidirSource), so they never disagree (blocker 2)',()=>{
  let bidir=false;const m=new MockRpmFilter('ok',()=>bidir);
  assert.equal(parseRpmFilterReport(m.report()).report.reason,'bidir-off','host bidir off -> bidir-off even in the ok scenario');
  bidir=true;assert.equal(parseRpmFilterReport(m.report()).report.reason,'ok');
  assert.equal(MockRpmFilter.scenarioBidir('bidir-off'),false);assert.equal(MockRpmFilter.scenarioBidir('ok'),true);
  const b=new MockRpmFilter('bidir-off',()=>true);
  assert.equal(parseRpmFilterReport(b.report()).report.reason,'erpm-unavailable','user enabled bidir: no telemetry yet (like the FW)');
 });
 await test('MockSerial: dshot_bidir and the RPM report agree; nothing but the user changes bidir (blocker 2)',async()=>{
  for(const [path,on,reason] of [['mock://bobflight-rpm-ok','on','ok'],['mock://bobflight-rpm-bidir-off','off','bidir-off'],['mock://bobflight-rpm-no-erpm','on','erpm-unavailable']]){
   const client=new BobFlightCliClient(new MockTransportFactory());
   await client.connect({path,transport:'mock'});await new Promise(r=>setTimeout(r,15));
   assert.equal((await client.sendCommand('get dshot_bidir')).trim(),`dshot_bidir=${on}`,path);
   assert.equal(parseRpmFilterReport(await client.sendCommand('rpm_filter')).report.reason,reason,path);
   await client.setSetting('rpm_filter_harmonics','2');
   assert.equal((await client.sendCommand('get dshot_bidir')).trim(),`dshot_bidir=${on}`,`${path}: a harmonics set never changes bidir`);
   const flip=on==='on'?'off':'on';
   assert.equal((await client.sendCommand(`set dshot_bidir ${flip}`)).trim(),`ok dshot_bidir=${flip}`);
   assert.equal(parseRpmFilterReport(await client.sendCommand('rpm_filter')).report.reason,flip==='off'?'bidir-off':'erpm-unavailable',`${path}: report follows the transport's bidir`);
   await client.disconnect();
  }
 });
 await test('real client over MockSerial: all scenarios, set re-read with get + rpm_filter, refused set verbatim',async()=>{
  const paths={off:'mock://bobflight',ok:'mock://bobflight-rpm-ok','bidir-off':'mock://bobflight-rpm-bidir-off','erpm-unavailable':'mock://bobflight-rpm-no-erpm','trimmed-1k':'mock://bobflight-rpm-1k','old-fc':'mock://bobflight-rpm-old'};
  for(const [s,path] of Object.entries(paths)){
   const client=new BobFlightCliClient(new MockTransportFactory());
   await client.connect({path,transport:'mock'});await new Promise(r=>setTimeout(r,15));
   const all=await client.getAllSettings();
   const rep=parseRpmFilterReport(await client.sendCommand('rpm_filter'));
   if(s==='old-fc'){
    for(const k of RPM_FILTER_KEYS)assert.equal(all[k],undefined,`old FC omits ${k} (never 0)`);
    assert.equal(rep.kind,'unsupported');
    await assert.rejects(client.getSetting('motor_poles'),/unknown key/);
    assert.equal(rpmFilterView({},rep).supported,false);
    await client.disconnect();continue;
   }
   for(const k of RPM_FILTER_KEYS)assert.equal(typeof all[k],'string',k);
   assert.equal(rep.kind,'report',s);assert.equal(rep.report.reason,s==='trimmed-1k'?'ok':s,s);
   if(s==='ok'){
    await assert.rejects(client.setSetting('motor_poles','13'),e=>e.message==='set failed: motor_poles must be even, 4..36');
    assert.deepEqual(await client.getSetting('motor_poles'),{key:'motor_poles',value:'14'},'refused set leaves the value unchanged');
    await client.setSetting('motor_poles','12');
    assert.equal((await client.getSetting('motor_poles')).value,'12');
    assert.equal(parseRpmFilterReport(await client.sendCommand('rpm_filter')).report.motorHz[1],'210','FC recomputes Hz from its own eRPM with 12 poles');
   }
   if(s==='off'){
    await client.setSetting('rpm_filter_q_x100','350');
    assert.equal((await client.getSetting('rpm_filter_q_x100')).value,'350');
   }
   await client.disconnect();
  }
 });
 console.log(`rpm-filter: ${passed} passed`);
}
main().catch(e=>{console.error(e);process.exit(1);});
