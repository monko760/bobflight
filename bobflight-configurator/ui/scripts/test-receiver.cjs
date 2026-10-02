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
  assert.deepEqual([parsed.rx_link_stats,parsed.rx_link_lq,parsed.rx_loss_reason],['absent','unavailable','no-frames']);
  const old=parseReceiver(new MockReceiver('old-fc').handle('receiver',false,false));
  assert.deepEqual([old.rx_link_stats,old.rx_link_lq,old.rx_loss_reason],[undefined,undefined,undefined]);
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
    /* Optional argv[3]: the link state this host board reports with no frames (dummy: unbound; a board with a bound receiver UART: waiting). */
    const idleLink=process.argv[3]||'unbound';
    for(const raw of replies){const r=parseReceiver(raw);assert.equal(r.map,'TAER');assert.equal(r.link,idleLink);assert.equal(r.frames,0);
      /* FW S2: the three link-statistics lines sit before the end marker. */
      assert.deepEqual([r.rx_link_stats,r.rx_link_lq,r.rx_loss_reason],['absent','unavailable','no-frames']);
      assert.match(raw,/persistence: \S+\r\nrx_link_stats: absent\r\nrx_link_lq: unavailable\r\nrx_loss_reason: no-frames\r\nreceiver_end: 1$/);}
    assert.match(run.stdout,/receiver map refused/);
  }
  console.log('PASS receiver parser, stale/invalid/incomplete rejection, settings guards, client allowlist and optional firmware readback');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
