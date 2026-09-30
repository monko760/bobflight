/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware gyro notch CLI (Kakute host build, schema 8) -> Configurator
 * notch parsers and Filters row model. Host build: proves the wire contract,
 * the FW refusal lines kept verbatim with the value unchanged, and a saved
 * 600 Hz notch reported above-nyquist after a 1 kHz loop change + reboot. The
 * host gyro path is passthrough, so this is not a DSP or hardware test. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {GYRO_NOTCH_KEYS,parseNotchGetReply,parseNotchSetReply,parseFiltersReport,notchRowView,notchWritePlan,parseStorage}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const PAD=' '.repeat(64);
function run(cmds,reinit=false){
 const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000,env:{...process.env,...(reinit?{BOBFLIGHT_HOST_REBOOT_REINIT:'1'}:{})}});
 assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;
}
const reports=o=>[...o.matchAll(/filters_api: 1\r?\n[\s\S]*?filters_end: 1\r?\n/g)].map(m=>m[0]);
const line=(o,re)=>{const m=re.exec(o);assert.ok(m,String(re));return m[0].replace(/\r$/,'');};
const get=(o,k)=>{const all=[...o.matchAll(new RegExp(`^${k}=.*$`,'gm'))];return all.map(m=>parseNotchGetReply(m[0],k));};

// 1. Defaults: every key 0, report off, exact frozen shape.
{
 const o=run([...GYRO_NOTCH_KEYS.map(k=>`get ${k}`),'filters','storage']);
 for(const k of GYRO_NOTCH_KEYS)assert.deepEqual(get(o,k),[{kind:'value',value:'0'}],k);
 const [raw]=reports(o);
 assert.deepEqual(raw.trim().split(/\r?\n/),['filters_api: 1','filters_sample_hz: 4000','gyro_notch1_active: no','gyro_notch1_reason: off','gyro_notch2_active: no','gyro_notch2_reason: off','filters_end: 1']);
 const rep=parseFiltersReport(raw);assert.equal(rep.kind,'report');
 const row=notchRowView(1,get(o,'gyro_notch1_hz')[0],get(o,'gyro_notch1_cutoff_hz')[0],rep);
 assert.deepEqual([row.supported,row.off,row.cutoffDisabled,row.active,row.reason],[true,true,true,'no','off']);
 const st=parseStorage(o.slice(o.indexOf('storage_api: 1'),o.indexOf('storage_end: 1')+'storage_end: 1'.length));
 assert.equal(st.schema,8);assert.ok(st.scope.endsWith(',gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz'));
}
// 2. Write plan over the real FW: every step accepted, then re-read with get.
{
 const plan=notchWritePlan(1,{center:0,cutoff:0},{center:200,cutoff:150});
 const o=run([...plan.map(s=>`set ${s.key} ${s.value}`),'get gyro_notch1_hz','get gyro_notch1_cutoff_hz','filters']);
 const oks=[...o.matchAll(/^ok gyro_notch1\S*$/gm)].map(m=>m[0]);assert.equal(oks.length,plan.length,o);
 plan.forEach((s,i)=>assert.deepEqual(parseNotchSetReply(oks[i],s.key),{ok:true,value:String(s.value)}));
 const rep=parseFiltersReport(reports(o)[0]);
 const row=notchRowView(1,get(o,'gyro_notch1_hz')[0],get(o,'gyro_notch1_cutoff_hz')[0],rep);
 assert.deepEqual([row.center,row.cutoff,row.active,row.reason],['200','150','yes','ok']);
 // Change an enabled notch without switching it off in between.
 const plan2=notchWritePlan(1,{center:200,cutoff:150},{center:300,cutoff:250});
 assert.ok(!plan2.some(s=>s.value===0));
 const o2=run(['set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200',...plan2.map(s=>`set ${s.key} ${s.value}`),'get gyro_notch1_hz','get gyro_notch1_cutoff_hz']);
 assert.ok(!/set failed/.test(o2),o2);
 assert.deepEqual([get(o2,'gyro_notch1_hz')[0],get(o2,'gyro_notch1_cutoff_hz')[0]],[{kind:'value',value:'300'},{kind:'value',value:'250'}]);
}
// 3. Refused sets: FW line verbatim through the parser, value unchanged on re-read.
{
 const o=run(['set gyro_notch1_hz 200','get gyro_notch1_hz','set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200','set gyro_notch1_cutoff_hz 250','get gyro_notch1_cutoff_hz']);
 const a=line(o,/^set failed: gyro_notch1_hz needs .*$/m);
 assert.deepEqual(parseNotchSetReply(a+'\r\n','gyro_notch1_hz'),{ok:false,unsupported:false,message:'set failed: gyro_notch1_hz needs 0 < gyro_notch1_cutoff_hz < gyro_notch1_hz (set the cutoff first)'});
 assert.deepEqual(get(o,'gyro_notch1_hz')[0],{kind:'value',value:'0'});
 const b=line(o,/^set failed: gyro_notch1_cutoff_hz .*$/m);
 assert.equal(parseNotchSetReply(b,'gyro_notch1_cutoff_hz').message,'set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz');
 assert.deepEqual(get(o,'gyro_notch1_cutoff_hz')[0],{kind:'value',value:'150'});
}
// 4. Save 600 Hz notch at 4 kHz, change loop to 1 kHz, save + reboot: above-nyquist, setting kept, refused centre verbatim.
{
 const o=run(['set gyro_notch2_cutoff_hz 420','set gyro_notch2_hz 600','filters','set loop_rate_hz 1000','save','reboot',PAD,
  'filters','get gyro_notch2_hz','get gyro_notch2_cutoff_hz','set gyro_notch2_hz 500','get gyro_notch2_hz','storage'],true);
 const [r0,r1]=reports(o).map(parseFiltersReport);
 assert.deepEqual(r0.report,{sampleHz:'4000',notches:{1:{active:'no',reason:'off'},2:{active:'yes',reason:'ok'}}});
 assert.deepEqual(r1.report,{sampleHz:'1000',notches:{1:{active:'no',reason:'off'},2:{active:'no',reason:'above-nyquist'}}});
 const after=o.slice(o.indexOf('reboot'));
 const c=get(after,'gyro_notch2_hz'),f=get(after,'gyro_notch2_cutoff_hz');
 assert.deepEqual(c,[{kind:'value',value:'600'},{kind:'value',value:'600'}],'kept, and unchanged after the refused set');
 const row=notchRowView(2,c[0],f[0],r1);
 assert.deepEqual([row.center,row.cutoff,row.active,row.reason],['600','420','no','above-nyquist'],'shown verbatim, no UI Nyquist math');
 const refused=line(after,/^set failed: gyro_notch2_hz must be below .*$/m);
 assert.equal(parseNotchSetReply(refused,'gyro_notch2_hz').message,'set failed: gyro_notch2_hz must be below 450 Hz at the running 1000 Hz loop rate');
 const st=parseStorage(after.slice(after.indexOf('storage_api: 1'),after.indexOf('storage_end: 1')+'storage_end: 1'.length));
 assert.equal(st.dirty,false,'runtime disable does not alter the stored config');assert.equal(st.schema,8);
}
console.log('PASS firmware gyro notch CLI -> Configurator notch parsers/rows: defaults off with the frozen filters report shape, write plan accepted and re-read, refusals verbatim with values unchanged, saved 600 Hz notch above-nyquist after 1 kHz loop + reboot (setting kept, storage clean). Host build.');
