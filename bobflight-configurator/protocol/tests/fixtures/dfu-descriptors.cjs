const assert=require('node:assert/strict');
const layout='@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg';
function config({value=1,iface=0,alt=0,string=5}={}) {
  const bytes=Buffer.from([9,2,45,0,1,value,0,0x80,50,
    9,4,iface,alt,0,0xfe,1,2,string,
    9,4,iface,alt+1,0,0xfe,1,2,string+1,
    9,4,iface,alt+2,0,0xfe,1,2,string+2,
    9,4,iface,alt+3,0,0xfe,1,2,string+3]);return bytes;
}
function device(options={}) {
  const configs=options.configs||[config()];const requests=[];
  return {requests,async controlTransferIn(s,n){
    requests.push({...s,length:n});
    assert.equal(s.requestType,'standard');assert.equal(s.recipient,'device');assert.equal(s.request,6);
    const type=s.value>>8,index=s.value&255;
    let b;
    if(type===1){b=Buffer.alloc(18);b[0]=18;b[1]=1;b[17]=configs.length;}
    else if(type===2)b=configs[index];
    else if(type===3 && index===0){b=Buffer.from([4,3,...(options.languageBytes||[9,4])]);}
    else if(type===3 && index===(options.stringIndex??5)){
      assert.equal(s.index,options.language??0x0409);
      const text=Buffer.from(options.layout??layout,'utf16le');b=Buffer.concat([Buffer.from([text.length+2,3]),text]);
    }else throw new Error('Unexpected descriptor');
    if(options.mutate)b=options.mutate(Buffer.from(b),type,index,n);
    if(options.stall)return{status:'stall'};
    b=b.subarray(0,n);const backing=new Uint8Array(b.length+8);backing.set(b,4);
    return {status:'ok',data:new DataView(backing.buffer,4,b.length)};
  }};
}
module.exports={device,config,layout};
