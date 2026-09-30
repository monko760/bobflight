/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {BobFlightCliClient,MockTransportFactory,ResponseCollector,MockOnboardBlackbox,formatOnboardStatus,formatOnboardStatusV1,formatDropPct}=require('../dist');
const {loadUiTs}=require('./load-ui-ts.cjs');
const {parseOnboardReply,describeOnboardRate,describeOnboardDrops,onboardAutoLowered,formatOnboardHz,formatOnboardRateReason,formatOnboardDropPct}=loadUiTs(path.join(__dirname,'../../ui/src/blackbox/onboard.ts'));
(async()=>{
 const client=new BobFlightCliClient(new MockTransportFactory());
 await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 for(const cmd of ['blackbox start','blackbox stop','blackbox status']){const text=await client.sendCommand(cmd);assert.match(text,/blackbox unavailable/);assert.match(text,/blackbox_end: 1/);assert(parseOnboardReply(text).unavailable);}
 for(const cmd of ['blackbox format','blackbox delete all','blackbox start\narm','blackbox start extra'])await assert.rejects(()=>client.sendCommand(cmd),/unsupported/);
 const err=await new Promise((resolve,reject)=>{const c=new ResponseCollector(()=>reject(Error('accepted incomplete recording reply')),resolve,{endMarker:'blackbox_end: 1',idleMs:1,timeoutMs:10});c.push('blackbox_state: done\r\n');});assert.match(err.message,/terminator missing/);
 assert(!client.getSentCommands().includes('arm'));await client.disconnect();

 // Case 1: api 2 default. Explicit simulations over the mock transport, parsed by the UI parser.
 const ok=new BobFlightCliClient(new MockTransportFactory());
 await ok.connect({path:'mock://bobflight-sd',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 let snap=parseOnboardReply(await ok.sendCommand('blackbox status'));
 assert.equal(snap.api,2);assert.equal(snap.state,'idle');assert.equal(snap.rateHz,500);assert.equal(snap.requestedHz,500);assert.equal(snap.rateReason,'default');assert.equal(snap.dropPct,'0.0');assert(!onboardAutoLowered(snap));
 snap=parseOnboardReply(await ok.sendCommand('blackbox start'));assert.equal(snap.state,'recording');assert(snap.active);
 snap=parseOnboardReply(await ok.sendCommand('blackbox status'));assert.equal(snap.frames,500);assert.equal(snap.dropped,0);assert.equal(snap.rateHz,500);assert.equal(describeOnboardRate(snap),'500 Hz');assert.equal(describeOnboardDrops(snap),'0 dropped (0.0%)');
 assert.match(await ok.sendCommand('blackbox start'),/blackbox refused/);
 snap=parseOnboardReply(await ok.sendCommand('blackbox stop'));assert.equal(snap.state,'done');assert(!snap.active);
 await ok.disconnect();

 // Case 2: api 2 auto-lowered.
 const slow=new BobFlightCliClient(new MockTransportFactory());
 await slow.connect({path:'mock://bobflight-sd-slow',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 parseOnboardReply(await slow.sendCommand('blackbox start'));
 snap=parseOnboardReply(await slow.sendCommand('blackbox status'));
 assert.equal(snap.rateHz,250);assert.equal(snap.requestedHz,500);assert.equal(snap.rateReason,'auto-lowered-card-slow');assert.equal(snap.dropped,80);assert.equal(snap.dropPct,'16.0');assert(onboardAutoLowered(snap));assert.match(describeOnboardRate(snap),/^250 Hz \(requested 500 Hz; auto-lowered/);
 snap=parseOnboardReply(await slow.sendCommand('blackbox status'));
 assert.equal(snap.rateHz,250);assert.equal(snap.frames,670);assert.equal(snap.dropped,80);assert.equal(snap.dropPct,'10.7'); // never raised; losses stay counted
 await slow.disconnect();

 // Case 3: api 1 FC (older firmware): old fields only; new fields are "unknown".
 const v1=new BobFlightCliClient(new MockTransportFactory());
 await v1.connect({path:'mock://bobflight-sd-api1',transport:'mock'});await new Promise(r=>setTimeout(r,15));
 let text=await v1.sendCommand('blackbox status');assert.match(text,/^blackbox_api: 1\r\n/);assert.doesNotMatch(text,/blackbox_rate_requested_hz|blackbox_rate_reason|blackbox_drop_pct/);
 parseOnboardReply(await v1.sendCommand('blackbox start'));
 snap=parseOnboardReply(await v1.sendCommand('blackbox status'));
 assert.equal(snap.api,1);assert.equal(snap.rateHz,500);assert.equal(snap.frames,75);assert.equal(snap.dropped,425);
 assert.equal(snap.requestedHz,null);assert.equal(snap.rateReason,null);assert.equal(snap.dropPct,null);assert(!onboardAutoLowered(snap));
 assert.equal(formatOnboardHz(snap.requestedHz),'unknown');assert.equal(formatOnboardRateReason(snap.rateReason),'unknown');assert.equal(formatOnboardDropPct(snap.dropPct),'unknown');
 assert.equal(describeOnboardDrops(snap),'425 dropped (unknown)'); // never computed as 85.0
 snap=parseOnboardReply(await v1.sendCommand('blackbox stop'));assert.equal(snap.state,'done');assert.equal(snap.dropPct,null);
 await v1.disconnect();

 // Direct helper checks: firmware rounding and armed refusal.
 assert.equal(formatDropPct(650,3731),'85.2');assert.equal(formatDropPct(0,0),'0.0');assert.equal(formatDropPct(1999,1),'0.1');assert.equal(formatDropPct(0,5),'100.0');
 const m=new MockOnboardBlackbox('ok');assert.match(m.handle('blackbox start',true),/blackbox refused/);assert.equal(m.handle('status'),null);
 assert.match(formatOnboardStatus({state:'idle',reason:'not-started',file:'',bytes:0,frames:0,rateHz:500,dropped:0,missed:0,invalid:0,queue:0,active:false,requestedHz:500,rateReason:'default'}),/blackbox_active: 0\r\nblackbox_rate_requested_hz: 500\r\nblackbox_rate_reason: default\r\nblackbox_drop_pct: 0\.0\r\nblackbox_end: 1\r\n$/);
 assert.match(formatOnboardStatusV1({state:'idle',reason:'not-started',file:'',bytes:0,frames:0,rateHz:500,dropped:0,missed:0,invalid:0,queue:0,active:false,requestedHz:500,rateReason:'default'}),/^blackbox_api: 1\r\n[\s\S]*blackbox_active: 0\r\nblackbox_end: 1\r\n$/);
 console.log('PASS recording allowlist, complete framing, honest unavailable mock, explicit SD simulations parsed by the UI: api 2 default, api 2 auto-lowered (verbatim FC drop %), api 1 (requested/reason/drop % unknown), and no injected commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
