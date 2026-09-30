/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware `status` loop keys (Kakute host build) -> real protocol framing ->
 * Configurator loop-rate parser and Setup view model. Host build: proves the wire
 * contract and the 8000/2 profile selection, not a hardware loop rate. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ResponseCollector,parseLoopStatus,loopRateView,parseStatus}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
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
 console.log(`PASS firmware status -> Configurator loop-rate readout: target ${v.items[0].value}, actual ${v.items[1].value}, overruns ${v.items[2].value}. Host build, not a hardware rate claim.`);
},20);
