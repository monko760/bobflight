/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware `blackbox status` (api 2) from the SD throughput model ->
 * real protocol framing -> real Configurator onboard parser.
 */
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {ResponseCollector,formatDropPct}=require('../../bobflight-configurator/protocol/dist');
const {loadUiTs}=require('../../bobflight-configurator/protocol/tests/load-ui-ts.cjs');
const {parseOnboardReply,describeOnboardRate,onboardAutoLowered}=loadUiTs(path.resolve(__dirname,'../../bobflight-configurator/ui/src/blackbox/onboard.ts'));
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_blackbox_throughput_test');
const out=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'bbl-status-')),'status.txt');
const r=spawnSync(binary,[out],{encoding:'utf8',maxBuffer:1024*1024,timeout:120000});
assert.equal(r.status,0,r.stdout+r.stderr);
const replies=fs.readFileSync(out,'utf8').split('---\n').filter(Boolean);
assert.equal(replies.length,4);
const parsed=replies.map(reply=>{
 let value=null,error=null;
 const c=new ResponseCollector(x=>value=x,e=>error=e,{idleMs:1,timeoutMs:100,endMarker:'blackbox_end: 1'});
 const cut=reply.indexOf('blackbox_end: 1')+4;c.push(reply.slice(0,cut));assert.equal(value,null);c.push(reply.slice(cut));
 assert.equal(error,null);assert.equal(value,reply);
 return parseOnboardReply(reply);
});
const [idle,good,slow,crawl]=parsed;
for(const s of parsed){assert.equal(s.api,2);assert(!s.unavailable);}
assert.equal(idle.state,'idle');assert.equal(idle.rateHz,500);assert.equal(idle.requestedHz,500);assert.equal(idle.rateReason,'default');assert.equal(idle.dropPct,'0.0');assert(!onboardAutoLowered(idle));
assert.equal(good.state,'done');assert.equal(good.rateHz,500);assert.equal(good.dropped,0);assert.equal(good.dropPct,'0.0');assert.equal(describeOnboardRate(good),'500 Hz');assert(!onboardAutoLowered(good));
assert.equal(slow.state,'done');assert.equal(slow.rateHz,250);assert.equal(slow.requestedHz,500);assert.equal(slow.rateReason,'auto-lowered-card-slow');assert(slow.dropped>0&&Number(slow.dropPct)>0);assert(onboardAutoLowered(slow));
assert.match(describeOnboardRate(slow),/requested 500 Hz; auto-lowered/);
assert.equal(crawl.rateHz,125);assert.equal(crawl.rateReason,'auto-lowered-card-slow');
// The UI shows the FC string verbatim; here the test checks the firmware's own rounding.
for(const s of [idle,good,slow,crawl])assert.equal(s.dropPct,formatDropPct(s.frames,s.dropped));
console.log(`PASS firmware->Configurator blackbox status api 2: idle/default, realistic 0 drops @500 Hz, slow ${slow.rateHz} Hz auto-lowered (${slow.dropped} dropped, ${slow.dropPct}%), very slow floor ${crawl.rateHz} Hz; split-marker framing and UI parser`);
