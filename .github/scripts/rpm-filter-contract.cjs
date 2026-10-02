/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware RPM filter CLI (Kakute host build, schema 9) -> Configurator
 * RPM parsers and Filters view model, plus mock/FW reply parity. Host build:
 * proves the wire contract, the FW refusal lines kept verbatim with the value
 * unchanged, bidir DShot never enabled by the filter, and the settings kept
 * across save + reboot. The host gyro path is passthrough and has no eRPM,
 * so this is not a DSP, tracking or hardware test. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {RPM_FILTER_KEYS,RPM_FILTER_REPORT_FIELDS,rpmFilterReportIsExact,parseRpmGetReply,parseRpmSetReply,parseRpmFilterReport,rpmFilterView,MockRpmFilter,parseStorage,STORAGE_SCOPE_V9}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const PAD=' '.repeat(64);
function run(cmds,reinit=false){
 const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000,env:{...process.env,...(reinit?{BOBFLIGHT_HOST_REBOOT_REINIT:'1'}:{})}});
 assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;
}
const reports=o=>[...o.matchAll(/rpm_filter_api: 1\r?\n[\s\S]*?rpm_filter_end: 1\r?\n/g)].map(m=>{
 assert.ok(rpmFilterReportIsExact(m[0]),'FW report is not in the frozen shape:\n'+m[0]);return m[0];});
const get=(o,k)=>[...o.matchAll(new RegExp(`^${k}=.*$`,'gm'))].map(m=>parseRpmGetReply(m[0],k));
const setLines=o=>[...o.matchAll(/^(?:ok (?:rpm_filter_\w+|motor_poles)=\S+|set failed.*)$/gm)].map(m=>m[0].replace(/\r$/,''));
const storage=o=>parseStorage(o.slice(o.lastIndexOf('storage_api: 1'),o.lastIndexOf('storage_end: 1')+'storage_end: 1'.length));
const values=o=>Object.fromEntries(RPM_FILTER_KEYS.map(k=>[k,get(o,k).at(-1)]));
const norm=s=>s.replace(/\r/g,'');

// 1. Defaults: 0/100/500/14, report off with the exact shape, schema 9 scope, bidir off.
{
 const o=run([...RPM_FILTER_KEYS.map(k=>`get ${k}`),'rpm_filter','get dshot_bidir','storage']);
 assert.deepEqual(RPM_FILTER_KEYS.map(k=>get(o,k)),[[{kind:'value',value:'0'}],[{kind:'value',value:'100'}],[{kind:'value',value:'500'}],[{kind:'value',value:'14'}]]);
 const [raw]=reports(o);
 // Frozen report: exactly these lines, in this order (the harmonics setting is read with get).
 // sample_hz 8000: since S1 the RPM filter runs on every gyro sample (Kakute 8000/2).
 assert.deepEqual(norm(raw).trim().split('\n'),['rpm_filter_api: 1','rpm_filter_active: no','rpm_filter_reason: off','rpm_filter_sample_hz: 8000','rpm_filter_harmonics_active: 0',
  'rpm_filter_m1_hz: unavailable','rpm_filter_m2_hz: unavailable','rpm_filter_m3_hz: unavailable','rpm_filter_m4_hz: unavailable','rpm_filter_end: 1']);
 const v=rpmFilterView(values(o),parseRpmFilterReport(raw));
 assert.deepEqual([v.supported,v.harmonics,v.minHz,v.q,v.motorPoles,v.reason,v.active,v.bidirOff],[true,'0','100','5','14','off','no',false]);
 assert.equal(norm(raw),norm(new MockRpmFilter('off').report()),'mock off report == FW (host has no eRPM, mock off reports unavailable too)');
 assert.match(o,/^dshot_bidir=off\r?$/m);
 const st=storage(o);assert.equal(st.schema,9);assert.equal(st.scope,STORAGE_SCOPE_V9);
}
// 2. Refusals verbatim, value unchanged; the mock answers the same lines.
{
 const cmds=['set rpm_filter_harmonics 4','set rpm_filter_min_hz 49','set rpm_filter_min_hz 201','set rpm_filter_q_x100 99','set rpm_filter_q_x100 1001','set rpm_filter_q_x100 3.5',
  'set motor_poles 13','set motor_poles 2','set motor_poles 38','set motor_poles abc'];
 const o=run([...cmds,...RPM_FILTER_KEYS.map(k=>`get ${k}`)]);
 const fw=setLines(o);
 const mock=new MockRpmFilter('off');const expected=cmds.map(c=>mock.handle(c,false).trim());
 assert.deepEqual(fw,expected,'FW and mock refusal lines identical');
 assert.deepEqual(fw.slice(0,3),['set failed: rpm_filter_harmonics must be 0..3','set failed: rpm_filter_min_hz must be 50..200','set failed: rpm_filter_min_hz must be 50..200']);
 assert.equal(fw[5],'set failed');assert.equal(fw[6],'set failed: motor_poles must be even, 4..36');
 for(const [i,c] of cmds.entries()){const k=c.split(' ')[1];const r=parseRpmSetReply(fw[i],k);assert.deepEqual(r,{ok:false,unsupported:false,message:fw[i]},c);}
 assert.deepEqual(RPM_FILTER_KEYS.map(k=>get(o,k)[0].value),['0','100','500','14'],'values unchanged after refusals');
}
// 3. Accepted sets re-read with get; bidir-off then erpm-unavailable after the user enables bidir; the filter never enables it.
{
 const o=run([...RPM_FILTER_KEYS.map(k=>`get ${k}`),'set rpm_filter_harmonics 2','get rpm_filter_harmonics','rpm_filter','get dshot_bidir','set dshot_bidir on','rpm_filter','set rpm_filter_q_x100 350','get rpm_filter_q_x100',
  'set motor_poles 12','get motor_poles','rpm_filter']);
 assert.deepEqual(setLines(o),['ok rpm_filter_harmonics=2','ok rpm_filter_q_x100=350','ok motor_poles=12']);
 for(const l of setLines(o)){const k=/^ok (\S+)=/.exec(l)[1];assert.equal(parseRpmSetReply(l,k).ok,true,l);}
 const [a,b,c]=reports(o).map(parseRpmFilterReport);
 assert.match(o,/^dshot_bidir=off\r?$/m,'harmonics 2 does not enable bidir');
 const early=o.slice(0,o.indexOf('set dshot_bidir on'));
 const va=rpmFilterView(values(early),a);assert.equal(va.harmonics,'2');
 assert.deepEqual([va.reason,va.active,va.harmonicsActive,va.bidirOff],['bidir-off','no','0',true]);
 assert.deepEqual([b.report.reason,b.report.active,b.report.harmonicsActive],['erpm-unavailable','no','0']);
 assert.ok(Object.values(c.report.motorHz).every(h=>h==='unavailable'),'no eRPM on the host: never invented');
 const vc=rpmFilterView(values(o),c);assert.deepEqual([vc.q,vc.motorPoles,vc.bidirOff],['3.5','12',false]);
 // Mock parity for the same state.
 const m=new MockRpmFilter('bidir-off');assert.equal(norm(reports(o)[0]),norm(m.report()),'mock bidir-off == FW');
 const e=new MockRpmFilter('erpm-unavailable');assert.equal(norm(reports(o)[1]),norm(e.report()),'mock erpm-unavailable == FW');
}
// 4. Save + reboot keeps the settings; at 1 kHz the report carries the new sample rate (no client trim math).
{
 const o=run(['set rpm_filter_harmonics 3','set rpm_filter_min_hz 80','set rpm_filter_q_x100 250','set motor_poles 16','set loop_rate_hz 1000','save','reboot',PAD,
  ...RPM_FILTER_KEYS.map(k=>`get ${k}`),'rpm_filter','storage'],true);
 const after=o.slice(o.indexOf('reboot'));
 assert.deepEqual(RPM_FILTER_KEYS.map(k=>get(after,k)[0]?.value),['3','80','250','16']);
 const rep=parseRpmFilterReport(reports(after).at(-1));
 assert.deepEqual([rep.report.sampleHz,rep.report.reason],['1000','bidir-off']);
 const v=rpmFilterView(values(after),rep);assert.deepEqual([v.q,v.minHz,v.motorPoles,v.harmonicsActive],['2.5','80','16','0']);
 const st=storage(after);assert.equal(st.schema,9);assert.equal(st.dirty,false);
}
console.log('PASS firmware rpm_filter CLI -> Configurator RPM parsers/view: defaults 0/100/500/14, every report in the frozen shape ('+RPM_FILTER_REPORT_FIELDS.length+' fields, no rpm_filter_harmonics line), refusals verbatim (== mock) with values unchanged, accepted sets re-read, bidir-off/erpm-unavailable (== mock), bidir never enabled, save + reboot keeps the settings at 1 kHz, schema 9 scope. Host build.');
