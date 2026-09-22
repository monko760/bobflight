/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {BobFlightCliClient,MockTransportFactory,ResponseCollector}=require('../dist');
(async()=>{
 const client=new BobFlightCliClient(new MockTransportFactory());
 await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 for(const cmd of ['blackbox start','blackbox stop','blackbox status']){const text=await client.sendCommand(cmd);assert.match(text,/blackbox unavailable/);assert.match(text,/blackbox_end: 1/);}
 for(const cmd of ['blackbox format','blackbox delete all','blackbox start\narm','blackbox start extra'])await assert.rejects(()=>client.sendCommand(cmd),/unsupported/);
 const err=await new Promise((resolve,reject)=>{const c=new ResponseCollector(()=>reject(Error('accepted incomplete recording reply')),resolve,{endMarker:'blackbox_end: 1',idleMs:1,timeoutMs:10});c.push('blackbox_state: done\r\n');});assert.match(err.message,/terminator missing/);
 assert(!client.getSentCommands().includes('arm'));await client.disconnect();console.log('PASS recording allowlist, complete framing, honest unavailable mock and no injected commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
