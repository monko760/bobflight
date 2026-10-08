const assert=require('node:assert/strict');
const {readDfuInterfaceName:read}=require('../dist/flasher/dfu-descriptors.js');
const {assertF405DfuLayout}=require('../dist/flasher/f405-diagnostic.js');
const fixture=require('./fixtures/dfu-descriptors.cjs');
(async()=>{
  const normal=fixture.device();assert.equal(await read(normal,1,0,0),fixture.layout);
  assert.equal(normal.requests.length,5);assert(normal.requests.every(r=>r.request===6&&r.requestType==='standard'&&r.recipient==='device'));
  const alternate=fixture.device({configs:[fixture.config({value:2}),fixture.config({value:7,iface:2,string:11})],stringIndex:11,language:0x0411,languageBytes:[0x11,4]});
  assert.equal(await read(alternate,7,2,0),fixture.layout);
  assert(alternate.requests.some(r=>r.value===0x0201));assert(alternate.requests.some(r=>r.value===0x030b&&r.index===0x0411));
  const mutations=[
    (b,t)=>{if(t===1)b[17]=255;return b;},
    (b,t)=>t===1?b.subarray(0,17):b,
    (b,t)=>{if(t===2)b[1]=3;return b;},
    (b,t)=>{if(t===2)b.writeUInt16LE(4097,2);return b;},
    (b,t,i,n)=>t===2&&n>9?b.subarray(0,b.length-1):b,
    (b,t,i,n)=>{if(t===2&&n>9)b[4]=2;return b;},
    (b,t,i,n)=>{if(t===2&&n>9)b[9]=0;return b;},
    (b,t,i,n)=>{if(t===2&&n>9)b[9]=255;return b;},
    (b,t,i,n)=>{if(t===2&&n>9)b[16]=1;return b;},
    (b,t,i,n)=>{if(t===2&&n>9)b[17]=0;return b;},
    (b,t,i,n)=>{if(t===2&&n>9)b[21]=0;return b;},
    (b,t,i)=>{if(t===3&&i===0)b.fill(0,2);return b;},
    (b,t,i)=>{if(t===3&&i===0)b[0]=3;return b;},
    (b,t,i)=>t===3&&i>0?b.subarray(0,b.length-1):b,
    (b,t,i)=>{if(t===3&&i>0)b[1]=2;return b;},
  ];
  for(const mutate of mutations)await assert.rejects(()=>read(fixture.device({mutate}),1,0,0),/No erase\/program issued/);
  for(const d of [fixture.device({stall:true}),fixture.device({configs:[fixture.config({value:2})]}),fixture.device({configs:[fixture.config(),fixture.config()]})])await assert.rejects(()=>read(d,1,0,0));
  const wrong=await read(fixture.device({layout:'@Internal Flash /0x08000000/04*016Kg,01*064Kg,03*128Kg'}),1,0,0);
  assert.throws(()=>assertF405DfuLayout(wrong),/not the selected/);
  const cancel=fixture.device();let calls=0;
  await assert.rejects(()=>read(cancel,1,0,0,()=>{if(++calls===4)throw new Error('cancelled');}),/cancelled/);
  assert.equal(cancel.requests.length,2);
  console.log('PASS raw DFU descriptors: null-name recovery, exact interface/alt, config value vs index, languages, offset views, malformed/truncated/oversized/missing/duplicate descriptors, stall, wrong geometry and cancellation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
