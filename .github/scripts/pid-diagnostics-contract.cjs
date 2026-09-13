/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware command dispatch/writer -> real protocol response framing.
 * Host has no physical IMU: all starts must honestly refuse, not fake validity.
 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ResponseCollector}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const valid=['pid_diag','pid_diag status','pid_diag start','pid_diag start rx','pid_diag stop'];
const invalid=['pid_diag start extra','pid_diag start rx extra','pid_diag stop all','pid_diag reset','pid_diag rx'];
const commands=['version','dump all',...valid,...invalid,'pid_diag','dump all','status'];
const r=spawnSync(binary,[],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024});
assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/-piddiag1/);
const frames=[...r.stdout.matchAll(/pid_diag_version: 1\r?\n[\s\S]*?pid_diag_end: 1\r?\n/g)].map(x=>x[0]);
assert.equal(frames.length,valid.length+1);
for(const frame of frames){
 assert.match(frame,/active: no\r?\n/);assert.match(frame,/valid: no\r?\n/);
 assert.match(frame,/motor_output: disabled\r?\n/);assert.match(frame,/mode: acro\r?\n/);
 assert(!/nan|infinity/.test(frame));assert(Buffer.byteLength(frame)<1024);
 let value=null,error=null;
 const c=new ResponseCollector(x=>value=x,e=>error=e,{idleMs:1,timeoutMs:100,endMarker:'pid_diag_end: 1'});
 // zero-based byte slices; split the end marker as on USB CDC.
 const cut=frame.indexOf('pid_diag_end: 1')+5;
 c.push(frame.slice(0,cut));assert.equal(value,null);c.push(frame.slice(cut));assert.equal(error,null);assert.equal(value,frame);
}
assert(frames.some(f=>/reason: gyro-unhealthy/.test(f)));
assert.equal((r.stdout.match(/pid_diag refused: invalid-command/g)||[]).length,invalid.length);
const backups=[...r.stdout.matchAll(/# bobflight_config: 1\r?\n[\s\S]*?# config_end: 1\r?\n/g)].map(x=>x[0]);
assert.equal(backups.length,2);assert.equal(backups[0],backups[1]);
assert(!backups[0].includes('pid_diag'));
assert.match(r.stdout,/arm: disarmed/);
console.log('PASS actual firmware PID CLI -> protocol framing: commands/argument refusals, truthful missing hardware, complete bounded frames, unchanged persistent config, disarmed. No hardware PID or DFU claim.');
