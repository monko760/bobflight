/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware `status` loop keys (Kakute host build) -> real protocol framing ->
 * Configurator loop-rate parser and Setup view model. Host build: proves the wire
 * contract, the default 4000 (8000/2) setting and the loop_rate_hz save + reboot
 * flow, not a hardware loop rate. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const {ResponseCollector,parseLoopStatus,loopRateView,parseStatus,parseLoopRateGetReply,parseLoopRateSetReply,parseLoopRateReport,loopRateSettingView,loopRateReasonView,
 MockLoopRateSetting,LOOP_RATE_ARMED_LINE,LOOP_RATE_INVALID_LINE,loopRateUnsupportedLine}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const no8kBinary=process.argv[3]?path.resolve(process.argv[3]):path.resolve(__dirname,'../../bobflight-firmware/build-contract-tmotor/bobflight_host');
/* Board without the 8 kHz gyro path (tmotor_f7_v2 host build) vs the Configurator's
 * "1000/1-no8k" mock: the replies to get / refused set 8000 / refused set 4000 /
 * loop_rate / set 1000 must be byte-identical (CRLF included), so the mock's
 * refusal line IS the FW line. The armed and invalid lines are checked against
 * the FW source (the host build cannot arm without a healthy gyro). */
function no8kFlow(){
 assert.ok(fs.existsSync(no8kBinary),`tmotor_f7_v2 host build missing: ${no8kBinary}`);
 const cmds=['get loop_rate_hz','set loop_rate_hz 8000','set loop_rate_hz 4000','loop_rate','get loop_rate_hz','set loop_rate_hz 1000'];
 const r=spawnSync(no8kBinary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);
 let scenario='1000/1-no8k';const mock=new MockLoopRateSetting(()=>scenario);
 const expected=cmds.map(c=>mock.handle(c,false)).join('');
 assert.ok(r.stdout.includes(expected),`FW tmotor_f7_v2 replies differ from the no-8k mock.\n--- mock ---\n${JSON.stringify(expected)}\n--- fw ---\n${JSON.stringify(r.stdout.slice(0,1200))}`);
 const refusal=loopRateUnsupportedLine('8000','tmotor_f7_v2');
 assert.equal(parseLoopRateSetReply(refusal+'\r\n','8000').message,refusal,'FW refusal shown verbatim');
 const cli=fs.readFileSync(path.resolve(__dirname,'../../bobflight-firmware/src/drivers/cli.c'),'utf8');
 const setBody=cli.slice(cli.indexOf('static void cmd_set('),cli.indexOf('v = strtof(valstr, &end);',cli.indexOf('static void cmd_set(')));
 assert.ok(setBody.includes(`cli_write_str("${LOOP_RATE_ARMED_LINE}\\r\\n")`),'FW cmd_set armed line == LOOP_RATE_ARMED_LINE');
 assert.ok(setBody.indexOf('ARM_ARMED')<setBody.indexOf('loop_rate_hz'),'FW checks armed before the loop_rate_hz value (mock order)');
 assert.ok(setBody.includes(`cli_write_str("${LOOP_RATE_INVALID_LINE}\\r\\n")`),'FW invalid line == LOOP_RATE_INVALID_LINE');
 assert.ok(setBody.includes('"set failed: loop_rate_hz %lu not supported on %s (no 8 kHz gyro path)\\r\\n"'),'FW unsupported format == loopRateUnsupportedLine');
 console.log('PASS firmware tmotor_f7_v2 (no 8 kHz gyro path) -> Configurator no-8k mock: get, refused set 8000/4000, loop_rate and set 1000 byte-identical; armed/invalid lines match FW source.');
}
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
/* B2 bidir over the real FW CLI (host build, no ESC): the Configurator reason
 * card shows loop_rate_reason exactly as the FW sends it. Default 4000 keeps
 * 8000/2 with bidir on (reason setting); 8000 + bidir is capped to 8000/2
 * (dshot-bidir-reply-window); bidir off restores 8000/1. The pre-B2
 * dshot-bidir-polled-listen reason is never sent. */
function bidirFlow(){
 const pad=' '.repeat(64);
 const reports=cmds=>{
  const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000,env:{...process.env,BOBFLIGHT_HOST_REBOOT_REINIT:'1'}});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.doesNotMatch(r.stdout,/dshot-bidir-polled-listen/,'B2 firmware never reports the polled-listen reason');
  return {out:r.stdout,reps:[...r.stdout.matchAll(/loop_rate_api: 1\r?\n[\s\S]*?loop_rate_end: 1\r?\n/g)].map(m=>({text:m[0],rep:parseLoopRateReport(m[0])}))};
 };
 const raw=t=>/^loop_rate_reason: (.*?)\r?$/m.exec(t)[1];
 const k=reports(['set dshot_bidir on',pad,'loop_rate','get dshot_bidir']);
 assert.match(k.out,/^ok dshot_bidir=on\r?$/m);assert.equal(k.reps.length,1);
 assert.equal(k.reps[0].rep.active,'8000/2','4000 + bidir keeps 4 kHz');assert.equal(k.reps[0].rep.reason,'setting');
 const kv=loopRateReasonView(k.reps[0].rep);assert.equal(kv.token,raw(k.reps[0].text));assert.equal(kv.fallback,false);
 const c=reports(['set loop_rate_hz 8000','save','reboot',pad,'loop_rate','set dshot_bidir on',pad,'loop_rate','status','set dshot_bidir off',pad,'loop_rate']);
 assert.equal(c.reps.length,3);
 assert.equal(c.reps[0].rep.active,'8000/1');assert.equal(c.reps[0].rep.reason,'setting');
 assert.equal(c.reps[1].rep.active,'8000/2');assert.equal(c.reps[1].rep.reason,'dshot-bidir-reply-window');
 const cv=loopRateReasonView(c.reps[1].rep);
 assert.equal(cv.token,raw(c.reps[1].text),'reason card token is exactly the FW line');assert.equal(cv.fallback,true);
 assert.doesNotMatch(cv.explanation,/forces a 1 kHz|polled/,'no pre-B2 copy for a B2 reason');
 const after=c.out.slice(c.out.indexOf(c.reps[1].text)+c.reps[1].text.length);const st=parseLoopStatus(after.slice(after.indexOf('board: ')));
 assert.equal(st.targetHz,'4000','8000 + bidir runs 4000 (host build)');
 const view=loopRateSettingView({kind:'value',value:'8000'},c.reps[1].rep,st.targetHz);
 assert.ok(view.notices.some(n=>n.includes('instead of its boot setting 8000 Hz (dshot-bidir-reply-window)')),view.notices.join(' | '));
 assert.equal(c.reps[2].rep.active,'8000/1');assert.equal(c.reps[2].rep.reason,'setting','bidir off restores the setting');
 console.log('PASS firmware bidir -> Configurator reason card: 4000 kept (setting), 8000 capped to 8000/2 (dshot-bidir-reply-window, target 4000), bidir off restores 8000/1. Host build.');
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
 no8kFlow();
 bidirFlow();
 console.log(`PASS firmware status -> Configurator loop-rate readout: target ${v.items[0].value}, actual ${v.items[1].value}, overruns ${v.items[2].value}. Host build, not a hardware rate claim.`);
},20);
