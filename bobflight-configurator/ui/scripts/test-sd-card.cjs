/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const mod={exports:{}};
new Function('exports','require','module',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/blackbox/sd-card.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,require,mod);
const {SdCardController,parseSdReply}=mod.exports;
const reply=state=>`sd_api: 1\r\nsd_state: ${state}\r\nsd_detail: test\r\nsd_capacity_bytes: 64000360448\r\nsd_partition_lba: 2048\r\nsd_filesystem_hint: exFAT\r\nsd_cluster_bytes: 32768\r\nsd_volume_flags: 0\r\nsd_io_error: 0\r\nsd_write_enabled: no\r\nsd_filesystem_validated: no\r\nsd_end: 1\r\n`;
(async()=>{
 const data=parseSdReply(reply('done'));assert.equal(data.capacityBytes,64000360448);assert.equal(data.filesystem,'exFAT');assert.equal(data.clusterBytes,32768);
 assert(parseSdReply('unknown - try help\r\n').unavailable);assert(parseSdReply('sd_state: unavailable-mock\r\nsd_end: 1\r\n').unavailable);
 for(const bad of [reply('done').replace('sd_end: 1',''),reply('done')+'sd_api: 1\n',reply('flying'),reply('done').replace('64000360448','NaN'),reply('done').replace('64000360448','9007199254740992'),reply('done').replace('sd_write_enabled: no','sd_write_enabled: yes')])assert.throws(()=>parseSdReply(bad));
 let time=0,connected=true,resolve;const calls=[];
 const link={getConnectionStatus:()=>connected?'connected':'disconnected',sendCommand:c=>{calls.push(c);return new Promise(r=>resolve=r);}};
 const sd=new SdCardController(link,()=>time);assert.equal(await sd.command('sd probe'),false);sd.setEnabled(true);await sd.tick();assert.equal(calls.length,0);
 const start=sd.command('sd probe');assert(sd.pending);assert.equal(await sd.command('sd probe'),false);resolve(reply('initializing'));await start;assert(sd.polling);
 await sd.tick();assert.equal(calls.length,1);time=1000;const poll=sd.tick();assert.equal(calls.at(-1),'sd status');await sd.tick();assert.equal(calls.length,2);resolve(reply('done'));await poll;assert(!sd.busy);
 const late=sd.command('sd status');sd.setEnabled(false);resolve(reply('done'));await late;assert.equal(sd.snapshot,null);sd.setEnabled(true);
 const retry=sd.command('sd probe');resolve(reply('initializing'));await retry;time+=15000;await sd.tick();assert(!sd.polling);assert.match(sd.error,/timed out/);assert.equal(calls.filter(c=>c==='sd probe').length,2);
 const cancelled=sd.command('sd cancel');resolve(reply('cancelled'));await cancelled;assert.equal(sd.snapshot.state,'cancelled');
 const disconnected=sd.command('sd status');connected=false;resolve(reply('done'));await disconnected;assert.notEqual(sd.snapshot.state,'done');assert.equal(await sd.command('sd probe'),false);
 connected=true;assert.equal(await sd.command('arm'),false);assert(calls.every(c=>['sd probe','sd status','sd cancel'].includes(c)));
 const broken=new SdCardController({getConnectionStatus:()=> 'connected',sendCommand:async()=>{throw Error('port lost');}});broken.setEnabled(true);assert.equal(await broken.command('sd probe'),false);assert(!broken.busy);assert.match(broken.error,/port lost/);
 console.log('PASS SD panel model: explicit start, serial requests, 1Hz bounded polling, no init retry, stale reply rejection, framing, bad values, cancellation, disconnect and no write/arm commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
