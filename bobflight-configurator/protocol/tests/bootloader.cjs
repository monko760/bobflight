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
async function main(){
 for(const [input,want] of [['bl','bl'],['BL','bl'],[' bL ','bl'],['BL DISCARD','bl discard'],['bl   discard','bl discard'],['diff all','diff all'],['DUMP ALL','dump all'],['calibrate_accel +x','calibrate_accel +x'],['save','save']])assert.equal(U.parseCliInput(input),want);
 const invalid=['bl extra','bl discard extra','bl discard;arm','bl;arm','bl\narm','bl discard\rreboot','bl\0','bl\t','arm extra','reboot extra','bench_switch extra','BENCH_SWITCH','save now','diff all extra','calibrate_accel +x extra'];
 for(const cmd of invalid){assert.equal(U.parseCliInput(cmd),null,cmd);const p=page();p.submit(cmd);assert.equal(p.dialog(),undefined);assert.equal(p.calls.length,0);}
 for(const cmd of U.ALLOWED_CLI_COMMANDS)assert.equal(U.parseCliInput(cmd),cmd);
 for(const raw of ['bl','BL','bl discard','BL DISCARD']){
  const p=page();p.submit(raw);assert.equal(p.calls.length,0,'must not send before confirmation');let d=p.dialog();assert(d);assert.equal(d.props.danger,true);assert.match(d.props.message,/No automatic save/);assert.match(d.props.message,/RAM-only/);assert.match(d.props.message,/not proof/);
  if(raw.toLowerCase().includes('discard'))assert.match(d.props.message,/DISCARD explicitly accepts losing unsaved configuration/);
  d.props.onCancel();assert.equal(p.dialog(),undefined);assert.equal(p.calls.length,0);
  p.submit(raw);p.dialog().props.onConfirm();await pause();assert.deepEqual(p.calls,[raw.toLowerCase()]);assert(p.lines.some(s=>s.includes('verify STM32 DFU')));
 }
 for(const cmd of ['arm','disarm','reboot','bench_switch']){const p=page();p.submit(cmd);assert(p.dialog());assert.equal(p.calls.length,0);p.dialog().props.onCancel();assert.equal(p.calls.length,0);}
 for(const cmd of ['diff all','dump all','save']){const p=page(true,'mock reply');p.submit(cmd);await pause();assert.deepEqual(p.calls,[cmd]);}
 const off=page(false);off.submit('bl');assert.equal(off.dialog(),undefined);assert.equal(off.calls.length,0);
 const failed=page(true,'','port closed');failed.submit('bl');failed.dialog().props.onConfirm();await pause();assert.deepEqual(failed.calls,['bl']);assert(failed.lines.some(s=>s.includes('Request not verified')));assert(!failed.lines.some(s=>s.includes('Reset acknowledged')));
 const refusal=page(true,'bl refused: unsaved configuration');refusal.submit('bl');refusal.dialog().props.onConfirm();await pause();assert(!refusal.lines.some(s=>s.includes('Reset acknowledged')));
 // Real protocol client: exact bytes, no hidden save/arm/retry, refusal vs port-close.
 for(const cmd of ['bl','bl discard']){
  const port=new Port('bl refused: unsaved configuration\r\n');const c=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>port});await c.connect({path:port.path});
  assert.match(await c.sendCommand(cmd),/bl refused/);assert.deepEqual(port.wires,[cmd+'\n']);
  for(const bad of ['bl extra','bl discard extra','bl\narm','bl discard\rreboot'])await assert.rejects(c.sendCommand(bad),/unsupported/);
  assert.deepEqual(port.wires,[cmd+'\n']);await c.disconnect();
 }
 const drop=new Port('',true);const c=new P.BobFlightCliClient({enumerate:async()=>[],open:async()=>drop});await c.connect({path:drop.path});await assert.rejects(c.sendCommand('bl'),/port closed/);await pause();assert.equal(c.getConnectionStatus(),'disconnected');assert.deepEqual(drop.wires,['bl\n']);
 const mock=new P.BobFlightCliClient(new P.MockTransportFactory());await mock.connect({path:'mock://bobflight'});await pause();
 for(const cmd of ['bl','bl discard'])assert.match(await mock.sendCommand(cmd),/mock transport has no ROM bootloader/);
 assert.equal(mock.getConnectionStatus(),'connected');await mock.disconnect();
 const {MockBobFlightHost}=loadUiTs(path.resolve(__dirname,'../../ui/src/protocol/mockHost.ts'));const browserMock=new MockBobFlightHost();await browserMock.connect({path:'mock://bobflight'});
 for(const cmd of ['bl','bl discard'])assert.match(await browserMock.sendCommand(cmd),/mock transport has no ROM bootloader/);
 assert.equal(browserMock.getConnectionStatus(),'connected');await browserMock.disconnect();
 console.log('PASS BL: exact full-line parser, aliases/arguments, injection rejection, actual CliPage confirm/cancel/disconnected/refusal/port-close flow, real client wire bytes and no autosave/retry, honest unsupported mocks. Not a hardware DFU test.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
