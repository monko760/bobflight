/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware `status` loop keys (Kakute host build) -> real protocol framing ->
 * Configurator loop-rate parser and Setup view model. Host build: proves the wire
 * contract, the default 4000 (8000/2) setting and the loop_rate_hz save + reboot
 * flow, not a hardware loop rate. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ResponseCollector,parseLoopStatus,loopRateView,parseStatus,parseLoopRateGetReply,parseLoopRateSetReply,parseLoopRateReport,loopRateSettingView}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
/* Persisted loop_rate_hz over the real FW CLI: get, invalid set rejected, set 8000
 * (pending, save + reboot note), save, host warm reboot (process-local flash kept),
 * then status loop_target_hz shows the applied rate. */
function settingFlow(){
 const cmds=['get loop_rate_hz','set loop_rate_hz 2000','set loop_rate_hz 8000','loop_rate','save','reboot',' '.repeat(64),'status','loop_rate','get loop_rate_hz'];
 const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000,env:{...process.env,BOBFLIGHT_HOST_REBOOT_REINIT:'1'}});
 assert.equal(r.status,0,r.stdout+r.stderr);const o=r.stdout;
 const gets=[...o.matchAll(/^loop_rate_hz=.*$/gm)].map(m=>parseLoopRateGetReply(m[0]));
 assert.deepEqual(gets,[{kind:'value',value:'4000'},{kind:'value',value:'8000'}]);
 const bad=/^set failed: loop_rate_hz.*$/m.exec(o);assert.ok(bad,'2000 rejected');assert.equal(parseLoopRateSetReply(bad[0],'4000').reason,'invalid');
 const ok=/^ok loop_rate_hz=8000\r?\n.*$/m.exec(o);assert.ok(ok);assert.deepEqual(parseLoopRateSetReply(ok[0],'8000'),{ok:true,value:'8000',rebootRequired:true});
 const reps=[...o.matchAll(/loop_rate_api: 1\r?\n[\s\S]*?loop_rate_end: 1\r?\n/g)].map(m=>parseLoopRateReport(m[0]));
 assert.equal(reps.length,2);
 assert.equal(reps[0].pendingReboot,true);assert.equal(reps[0].bootSettingHz,'4000');assert.equal(reps[0].settingHz,'8000');
 assert.match(o,/^saved: host_sim verified\r?$/m);
 assert.equal(reps[1].pendingReboot,false);assert.equal(reps[1].bootSettingHz,'8000');assert.equal(reps[1].profile,'8000/1');
 const after=o.slice(o.indexOf('reboot...'));const st=parseLoopStatus(after.slice(after.indexOf('board: ')));
 assert.equal(st.targetHz,'8000','applied rate after save + reboot (host build)');
 const view=loopRateSettingView(gets[1],reps[1],st.targetHz);
 assert.equal(view.display,'8 kHz');assert.equal(view.pendingReboot,false);assert.ok(!view.notices.some(n=>/instead of/.test(n)));
 console.log('PASS firmware loop_rate_hz -> Configurator selector model: default 4000, 2000 rejected, 8000 pending until save + reboot, then loop_target_hz 8000. Host build.');
}
const run=spawnSync(binary,[],{input:'status\nloop_rate\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000});
assert.equal(run.status,0,run.stdout+run.stderr);
const out=run.stdout;
const start=out.indexOf('board: ');assert.ok(start>=0,'status reply present');
const end=out.indexOf('loop_rate_api: 1');assert.ok(end>start,'loop_rate reply follows status');
const statusText=out.slice(start,end);
// Same collector the app uses for `status` (idle-framed, no end marker).
let value=null,error=null;
const c=new ResponseCollector(x=>value=x,e=>error=e,{idleMs:1,timeoutMs:100});
c.push(statusText);
setTimeout(()=>{
 assert.equal(error,null);assert.ok(value&&value.includes('loop_overruns: '),'framed status keeps the loop keys');
 const lines=value.split(/\r?\n/);
 const at=k=>lines.findIndex(l=>l.startsWith(k+': '));
 const iLoop=at('loop');assert.ok(iLoop>=0);
 assert.deepEqual([at('loop_target_hz'),at('loop_actual_hz'),at('loop_overruns')],[iLoop+1,iLoop+2,iLoop+3],'keys follow loop: in frozen order');
 for(const k of ['loop_target_hz','loop_actual_hz','loop_overruns'])assert.equal(lines.filter(l=>l.startsWith(k+': ')).length,1,`${k} exactly once`);
 const p=parseLoopStatus(value);
 const raw=k=>/^[a-z_]+: (.*)$/.exec(lines[at(k)].trim())[1];
 assert.equal(p.targetHz,raw('loop_target_hz'),'target shown exactly as sent');
 assert.equal(p.targetHz,'4000','Kakute profile 8000/2 -> 4000 Hz target on the host build');
 assert.match(raw('loop_actual_hz'),/^(unavailable|0|[1-9][0-9]*)$/);
 assert.equal(p.actualHz,raw('loop_actual_hz')==='unavailable'?null:raw('loop_actual_hz'));
 assert.match(p.overruns,/^(0|[1-9][0-9]*)$/);assert.equal(p.overruns,raw('loop_overruns'));
 const v=loopRateView(p);
 assert.equal(v.items[0].value,'4000');assert.equal(v.items[1].label,'Loop actual (Hz, last ~1 s)');
 assert.equal(v.items[1].value,p.actualHz??'unknown');
 const legacy=parseStatus(value);assert.match(legacy.loop,/^gyro=8000 Hz denom=2 /,'legacy loop: line agrees with the target');
 assert.match(out,/loop_rate_profile: 8000\/2/);assert.match(out,/loop_rate_end: 1/);
 const repEnd=out.indexOf('loop_rate_end: 1',end);assert.ok(repEnd>end);const boot=parseLoopRateReport(out.slice(end,repEnd+'loop_rate_end: 1'.length));assert.equal(boot.settingHz,'4000','Kakute default loop_rate_hz is 4000');
 assert.equal(boot.bootSettingHz,'4000');assert.equal(boot.pendingReboot,false);assert.equal(boot.reason,'setting');
 settingFlow();
 console.log(`PASS firmware status -> Configurator loop-rate readout: target ${v.items[0].value}, actual ${v.items[1].value}, overruns ${v.items[2].value}. Host build, not a hardware rate claim.`);
},20);
