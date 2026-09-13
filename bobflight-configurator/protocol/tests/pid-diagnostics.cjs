/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {loadUiTs}=require('./load-ui-ts.cjs');
const P=require('../dist');
const U=loadUiTs(path.resolve(__dirname,'../../ui/src/protocol/types.ts'));
const pause=()=>new Promise(r=>setImmediate(r));
function nodes(t){if(Array.isArray(t))return t.flatMap(nodes);if(!t||typeof t!=='object')return [];return [t,...nodes(t.props?.children)];}
function page(connected=true,reply='bl: resetting to ST ROM bootloader\r\n',error=null){
 let values=[],cursor=0;const calls=[],lines=[];
 const react={...require('react'),useEffect:()=>{},useRef:()=>({current:null}),useState:init=>{
  const i=cursor++;if(!(i in values))values[i]=init;
  return [values[i],v=>values[i]=typeof v==='function'?v(values[i]):v];
 }};
 const host={sendCommand:async cmd=>{calls.push(cmd);if(error)throw Error(error);return reply;},getConnectionStatus:()=>connected?'connected':'disconnected'};
 const C=loadUiTs(path.resolve(__dirname,'../../ui/src/pages/CliPage.tsx'),{
  react,'../protocol':U,'../hooks/useHost':{useHost:()=>({host,connectionStatus:connected?'connected':'disconnected',cliLines:[],appendCli:s=>lines.push(s),refreshStatus:async()=>{}})}
 });
 function render(){cursor=0;return C.CliPage();}
 function submit(input){let t=render();nodes(t).find(n=>n.type==='input').props.onChange({target:{value:input}});t=render();nodes(t).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});return render();}
 function dialog(){return nodes(render()).find(n=>typeof n.type==='function'&&n.type.name==='ConfirmDialog');}
 return {calls,lines,render,submit,dialog};
}
class Port extends EventEmitter {
 constructor(reply,drop=false){super();this.reply=reply;this.drop=drop;this.path='test://bl';this.baudRate=115200;this.isOpen=true;this.wires=[];}
 async open(){this.isOpen=true;}
 async close(){this.isOpen=false;this.emit('close');}
 write(s){this.wires.push(String(s));queueMicrotask(()=>{if(this.reply)this.emit('data',Buffer.from(this.reply));if(this.drop)void this.close();});return true;}
}

const snapshot='pid_diag_version: 1\r\nactive: yes\r\nvalid: yes\r\nreason: running\r\nsource: zero\r\nmode: acro\r\nsample_seq: 10\r\nsample_age_us: 0\r\ndt_us: 1000\r\nsetpoint_dps: 0 0 0\r\ngyro_dps: 10 0 0\r\nerror_dps: -10 0 0\r\ncorrection: -0.4 0 0\r\nmotor_output: disabled\r\npid_diag_end: 1\r\n';
const commands=['pid_diag','pid_diag status','pid_diag start','pid_diag start rx','pid_diag stop'];
async function main(){
 for(const cmd of commands){
  assert.equal(U.parseCliInput(cmd.toUpperCase()),cmd);
  const p=page(true,snapshot);p.submit(cmd);await pause();assert.deepEqual(p.calls,[cmd]);assert.equal(p.dialog(),undefined);
  const off=page(false);off.submit(cmd);assert.equal(off.calls.length,0);
  const port=new Port(snapshot);const c=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>port});await c.connect({path:port.path});
  assert.equal(await c.sendCommand(cmd),snapshot);assert.deepEqual(port.wires,[cmd+'\n']);await c.disconnect();
 }
 for(const bad of ['pid_diag start angle','pid_diag rx','pid_diag reset','pid_diag start rx extra','pid_diag start;arm','pid_diag\narm','pid_diag\0','pid_diag\tstart','pid_diag stop all']){
  assert.equal(U.parseCliInput(bad),null);const p=page();p.submit(bad);assert.equal(p.calls.length,0);
  const port=new Port(snapshot);const c=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>port});await c.connect({path:port.path});await assert.rejects(c.sendCommand(bad),/unsupported/);assert.deepEqual(port.wires,[]);await c.disconnect();
 }
 let result=null;let error=null;const f=new P.ResponseCollector(x=>result=x,e=>error=e,{idleMs:1,timeoutMs:100,endMarker:'pid_diag_end: 1'});
 f.push(snapshot.slice(0,-8));assert.equal(result,null);f.push(snapshot.slice(-8,-2));assert.equal(result,null);f.push(snapshot.slice(-2));assert.match(result,/motor_output: disabled/);assert.equal(error,null);
 const port=new Port('pid_diag_version: 1\r\nactive: yes\r\n');const c=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>port});await c.connect({path:port.path});
 await assert.rejects(c.sendCommand('pid_diag',{timeoutMs:30,idleMs:1}),/terminator missing/);await pause();assert.equal(c.getConnectionStatus(),'disconnected');assert.deepEqual(port.wires,['pid_diag\n']);
 const oldPort=new Port('unknown — try help\r\n');const old=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>oldPort});await old.connect({path:oldPort.path});assert.match(await old.sendCommand('pid_diag'),/unknown/);await old.disconnect();
 const mock=new P.BobFlightCliClient(new P.MockTransportFactory());await mock.connect({path:'mock://bobflight'});await pause();
 for(const cmd of commands){const reply=await mock.sendCommand(cmd);assert.match(reply,/pid_diag_available: no/);assert.match(reply,/mock-no-hardware/);assert.match(reply,/pid_diag_end: 1/);}await mock.disconnect();
 const {MockBobFlightHost}=loadUiTs(path.resolve(__dirname,'../../ui/src/protocol/mockHost.ts'));const uiMock=new MockBobFlightHost();await uiMock.connect({path:'mock://bobflight'});for(const cmd of commands)assert.match(await uiMock.sendCommand(cmd),/pid_diag_available: no/);await uiMock.disconnect();
 const failed=page(true,'','port closed');failed.submit('pid_diag start');await pause();assert.deepEqual(failed.calls,['pid_diag start']);assert(failed.lines.some(x=>x.includes('port closed')));
 console.log('PASS PID diagnostics: actual CLI submission, complete arguments, strict allowlists, exact wire bytes, framed/split/truncated replies, old-firmware fallback, no implicit motor/save/retry and honest mock unavailability. Not a hardware test.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
