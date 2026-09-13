const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const mod={exports:{}};
new Function('exports','require','module',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/blackbox/recorder.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,require,mod);
const {Recorder,QUERIES,csv}=mod.exports;
(async()=>{
 let time=0,connected=true,calls=[],resolve;
 const link={getConnectionStatus:()=>connected?'connected':'disconnected',sendCommand:cmd=>{calls.push(cmd);return new Promise(r=>resolve=r);}};
 const r=new Recorder(link,()=>time);
 assert.equal(r.start([]),false);assert.equal(r.start(['arm']),false);
 assert(r.start(QUERIES));const first=r.tick();await r.tick();assert.deepEqual(calls,['version']);
 time=15;resolve('BobFlight test');await first;assert.equal(r.log.samples[0].received_ms,15);
 for(const q of QUERIES){const p=r.tick();assert.equal(calls.at(-1),q);resolve('value: 1\r\n');await p;}
 assert(calls.every(c=>c==='version'||QUERIES.includes(c)));
 const pending=r.tick();r.stop('left-tab');assert.equal(r.start(QUERIES),false);const count=r.log.samples.length;resolve('late');await pending;assert.equal(r.log.samples.length,count);
 assert(r.start(['sensors']));connected=false;await r.tick();assert.equal(r.log.reason,'disconnected');assert.equal(r.start(QUERIES),false);
 connected=true;assert(r.start(QUERIES));time+=600000;await r.tick();assert.equal(r.log.reason,'ten-minute-limit');
 assert(r.start(QUERIES));const huge=r.tick();resolve('x'.repeat(4*1024*1024+1));await huge;assert.equal(r.log.reason,'memory-limit');assert.equal(r.log.samples.length,0);
 const bad=new Recorder({getConnectionStatus:()=> 'connected',sendCommand:async()=>{throw Error('port lost');}});bad.start(QUERIES);await bad.tick();assert.equal(bad.log.reason,'request-failed');assert.match(bad.log.samples[0].error,/port lost/);
 bad.log.samples.push({command:'status',requested_ms:1,received_ms:2,raw:'unsafe: =CMD()\r\nquoted: a,"b"\r\n'});
 assert.match(csv(bad.log),/'=CMD/);assert.match(csv(bad.log),/a,""b""/);
 assert.equal(JSON.parse(JSON.stringify(bad.log)).schema,1);
 console.log('PASS blackbox: read-only command sequence, serialization, timestamps, cancellation, disconnect, limits, error preservation and CSV escaping');
})().catch(e=>{console.error(e);process.exit(1);});
