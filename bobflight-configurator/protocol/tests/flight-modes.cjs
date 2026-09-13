/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../dist');
const {parseModes,MockPortsModes,isControlSourceCommand,controlSourceCommand,canEditModeRanges,canSelectControlSource,ResponseCollector,BobFlightCliClient,MockTransportFactory}=P;
async function main(){
 const mock=new MockPortsModes(),raw=mock.handle('modes',false,false),s=parseModes(raw);
 assert.equal(s.apiVersion,2);assert.equal(s.modes.length,4);assert.equal(s.armSemantics,'preview');assert.equal(s.requestedMode,'angle');assert.equal(s.controlSource,'manual');
 const legacy=['modes_api: 1','persistence: session','semantics: preview','flight_enabled: 0','armed: 0','bench_active: 0','rx_fresh: 0','mode: ARM,1,1,1751,2100,0','mode: ANGLE,1,2,900,2100,0','modes_end: 1',''].join('\r\n');
 const old=parseModes(legacy);assert.equal(old.apiVersion,1);assert.equal(old.modes.length,2);assert.equal(canSelectControlSource(old,true,false),false);
 for(const bad of [raw.replace('modes_api: 2','modes_api: 9'),raw.replace('arm_semantics: preview','arm_semantics: control'),raw.replace('calibration_active: 0\r\n',''),raw.replace('mode_conflict: 0','mode_conflict: 1'),raw.replace('requested_mode: angle','requested_mode: unknown'),raw.replace('mode: ACRO','mode: ARM'),raw.replace('mode: HORIZON','mode: LEVEL'),raw.replace('control_source: manual','control_source: auto'),raw.replace('control_source: manual','control_source: aux').replace('requested_mode: angle','requested_mode: acro'),raw.replace('modes_end: 1','modes_end: 1\nextra')])assert.throws(()=>parseModes(bad),bad);
 const conflict=raw.replace('rx_fresh: 0','rx_fresh: 1').replace('control_source: manual','control_source: aux').replace('ANGLE,1,2,900,2100,0','ANGLE,1,2,900,2100,1').replace('ACRO,0,2,900,2100,0','ACRO,1,2,900,2100,1').replace('mode_conflict: 0','mode_conflict: 1');
 assert.equal(parseModes(conflict).modeConflict,true);
 for(const cmd of ['control_source aux','control_source manual']){assert.equal(isControlSourceCommand(cmd),true);assert.equal(parseModes(mock.handle(cmd,false,false)).controlSource,cmd.split(' ')[1]);}
 for(const cmd of ['control_source AUX','control_source aux extra','control_source aux\narm','control_source  aux','control_source auto']){assert.equal(isControlSourceCommand(cmd),false);assert.match(mock.handle(cmd,false,false),/refused/);}
 assert.equal(controlSourceCommand('aux'),'control_source aux');assert.throws(()=>controlSourceCommand('auto'));
 assert.match(mock.handle('control_source aux',true,false),/refused/);assert.match(mock.handle('control_source aux',false,true),/refused/);
 assert.equal(canEditModeRanges(s,true,false),true);assert.equal(canSelectControlSource(s,true,false),true);
 for(const [snapshot,connected,pending] of [[null,true,false],[s,false,false],[s,true,true],[{...s,armed:true},true,false],[{...s,benchActive:true},true,false],[{...s,calibrationActive:true},true,false]]){
  assert.equal(canEditModeRanges(snapshot,connected,pending),false);assert.equal(canSelectControlSource(snapshot,connected,pending),false);
 }
 assert.equal(canSelectControlSource({...s,flightEnabled:true},true,false),false);
 let response=null;const c=new ResponseCollector(x=>response=x,e=>{throw e},{endMarker:'modes_end: 1'});c.push('control_source refused: calibration');assert.equal(response,null);c.push('\r\n');assert.match(response,/refused/);
 const client=new BobFlightCliClient(new MockTransportFactory());await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,20));
 assert.equal(parseModes(await client.sendCommand('control_source aux')).controlSource,'aux');
 await assert.rejects(()=>client.sendCommand('control_source aux\narm'),/unsupported/);await client.disconnect();
 // Exercise the actual ModesPage component, injecting only hooks/snapshot transport.
 const ts=require('typescript');const file=path.resolve(__dirname,'../../ui/src/pages/ModesPage.tsx');
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 function page(snapshot,connected=true,pending=false){
  const calls=[];const module={exports:{}};
  const query={snapshot,connected,pending,error:'',loadedAt:1,execute:async(cmd,verify)=>{calls.push(cmd);const v={...snapshot,controlSource:cmd.endsWith('aux')?'aux':'manual'};verify?.(v);return v;}};
  const react={...require('react'),useEffect:()=>{},useState:initial=>[initial===null?snapshot?.modes??null:initial,()=>{}]};
  const customRequire=id=>id==='react'?react:id==='../protocol'?P:id==='./useConfigSnapshot'?{useConfigSnapshot:()=>query}:require(id);
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{console})(customRequire,module,module.exports);
  return {tree:module.exports.ModesPage(),calls};
 }
 function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)];}
 function text(t){return Array.isArray(t)?t.map(text).join(''):t&&typeof t==='object'?text(t.props?.children):String(t??'');}
 const ready=page(s);assert.match(text(ready.tree),/Level \(Horizon\)/);assert.match(text(ready.tree),/ARM — preview only/);
 const button=nodes(ready.tree).find(n=>n.type==='button'&&text(n)==='Enable AUX mode selection');assert.equal(button.props.disabled,false);await button.props.onClick();assert.deepEqual(ready.calls,['control_source aux']);
 for(const [snap,connected,pending] of [[s,false,false],[s,true,true],[{...s,armed:true},true,false],[{...s,benchActive:true},true,false],[{...s,calibrationActive:true},true,false],[{...s,flightEnabled:true},true,false]]){
  const p=page(snap,connected,pending),b=nodes(p.tree).find(n=>n.type==='button'&&text(n)==='Enable AUX mode selection');
  if(b){assert.equal(b.props.disabled,true);await b.props.onClick();}assert.deepEqual(p.calls,[]);
 }
 const disconnected=page(s,false);assert.doesNotMatch(text(disconnected.tree),/Last snapshot:/);assert.doesNotMatch(text(disconnected.tree),/Requested at snapshot:/);
 assert.match(text(page(old).tree),/Legacy firmware/);assert.equal(nodes(page(old).tree).some(n=>n.type==='button'&&text(n)==='Enable AUX mode selection'),false);
 console.log('PASS flight modes: API2/legacy strict parsing, overlap/stale fallback, source allowlist/framing, client roundtrip and actual ModesPage guard/readback/disconnect wiring');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
