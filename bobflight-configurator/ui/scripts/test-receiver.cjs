const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {spawnSync}=require('node:child_process');
const m={exports:{}};
new Function('exports','require','module',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/protocol/receiver.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m.exports,require,m);
const {parseReceiver}=m.exports;
const {MockReceiver}=require('../../protocol/dist/receiver-mock.js');
const {BobFlightCliClient,MockTransportFactory}=require('../../protocol/dist/index.js');
async function main(){
  const mock=new MockReceiver();
  const reply=mock.handle('receiver',false,false);
  const parsed=parseReceiver(reply);
  assert.equal(parsed.link,'unbound');assert.equal(parsed.channels.length,16);
  assert.throws(()=>parseReceiver('unknown — try help'));
  assert.throws(()=>parseReceiver(reply.replace('receiver_end: 1','')));
  assert.throws(()=>parseReceiver(reply.replace('armed: 0','armed: 7')));
  assert.throws(()=>parseReceiver(reply.replace('link: unbound','link: live')));
  assert.throws(()=>parseReceiver(reply.replace('0.000','NaN')));
  assert.equal(parseReceiver(mock.handle('receiver_map TAER',false,false)).map,'TAER');
  assert.match(mock.handle('receiver_map AETR',true,false),/refused/);
  assert.match(mock.handle('receiver_map AETR',false,true),/refused/);
  const client=new BobFlightCliClient(new MockTransportFactory());
  await client.connect({path:'mock://bobflight'});
  await new Promise(r=>setImmediate(r));
  assert.equal(parseReceiver(await client.sendCommand('receiver')).link,'unbound');
  assert.equal(parseReceiver(await client.sendCommand('receiver_map TAER')).map,'TAER');
  for(const cmd of ['receiver_map AAAA','receiver_uart 5','receiver_map TAER\narm','receiver now']) await assert.rejects(client.sendCommand(cmd),/unsupported/);
  await client.disconnect();
  if(process.argv[2]){
    const run=spawnSync(process.argv[2],[],{input:'receiver_map TAER\nreceiver\nreceiver_map BAD\nreceiver\n',encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const replies=run.stdout.match(/receiver_api: 1[\s\S]*?receiver_end: 1/g);
    assert.equal(replies.length,3);
    for(const raw of replies){const r=parseReceiver(raw);assert.equal(r.map,'TAER');assert.equal(r.link,'unbound');assert.equal(r.frames,0);}
    assert.match(run.stdout,/receiver map refused/);
  }
  console.log('PASS receiver parser, stale/invalid/incomplete rejection, settings guards, client allowlist and optional firmware readback');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
