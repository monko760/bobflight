/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {BobFlightCliClient,MockTransportFactory,ResponseCollector}=require('../dist');
(async()=>{
 const client=new BobFlightCliClient(new MockTransportFactory());
 await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 for(const cmd of ['sd probe','sd status','sd cancel']){const text=await client.sendCommand(cmd);assert.match(text,/unavailable-mock/);assert.match(text,/sd_write_enabled: no/);assert.match(text,/sd_end: 1/);}
 for(const cmd of ['sd format','sd write 0','sd probe\narm','sd status extra'])await assert.rejects(()=>client.sendCommand(cmd),/unsupported/);
 const err=await new Promise((resolve,reject)=>{const c=new ResponseCollector(()=>reject(Error('accepted incomplete SD response')),resolve,{endMarker:'sd_end: 1',idleMs:1,timeoutMs:10});c.push('sd_state: done\r\n');});assert.match(err.message,/terminator missing/);
 assert(!client.getSentCommands().includes('arm'));await client.disconnect();console.log('PASS SD command allowlist, no auto-arm, framing and honest mock');
})().catch(e=>{console.error(e);process.exitCode=1;});
