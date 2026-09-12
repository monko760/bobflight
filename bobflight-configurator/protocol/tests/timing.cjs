/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {ResponseCollector,BobFlightCliClient,MockTransportFactory}=require('../dist');
async function main(){
 let value=null,error=null;
 const c=new ResponseCollector(x=>value=x,e=>error=e,{idleMs:1,timeoutMs:100,endMarker:'timing_end: 1'});
 c.push('timing_version: 1\r\ntimebase: dwt-cyccnt\r\ntiming_en');assert.equal(value,null);
 c.push('d: 1');assert.equal(value,null);c.push('\r\n');assert.match(value,/timebase: dwt-cyccnt/);assert.equal(error,null);
 const truncated=await new Promise((resolve,reject)=>{
  const t=new ResponseCollector(()=>reject(Error('accepted truncation')),resolve,{idleMs:1,timeoutMs:10,endMarker:'timing_end: 1'});
  t.push('timing_version: 1\r\n');
 });assert.match(truncated.message,/terminator missing/);
 let old=null;new ResponseCollector(x=>old=x,()=>{},{endMarker:'timing_end: 1'}).push('unknown — try help\r\n');assert.match(old,/unknown/);
 const client=new BobFlightCliClient(new MockTransportFactory());
 await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 const response=await client.sendCommand('timing');assert.match(response,/timing_available: no/);assert.match(response,/mock-no-hardware/);assert.match(response,/timing_end: 1/);
 for(const cmd of ['timing reset','timing\narm','timing extra'])await assert.rejects(()=>client.sendCommand(cmd),/unsupported/);
 await client.disconnect();console.log('PASS timing: framed split response, truncation, old firmware, read-only allowlist and honest mock');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
