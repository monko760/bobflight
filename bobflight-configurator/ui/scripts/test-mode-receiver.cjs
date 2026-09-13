/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadUiTs}=require('../../protocol/tests/load-ui-ts.cjs');
const realReact=require('react');
const hookPath=path.resolve(__dirname,'../src/hooks/useModeReceiver.ts');
const helpers=loadUiTs(hookPath,{'./useHost':{useHost:()=>{throw Error('No host needed for conversion tests');}}});
assert.equal(helpers.auxMicroseconds(-1),1000);
assert.equal(helpers.auxMicroseconds(0),1500);
assert.equal(helpers.auxMicroseconds(1),2000);
const channels=Array(16).fill(0),next=[...channels];
next[4]=1;next[15]=-1;next[0]=1;
assert.equal(JSON.stringify(helpers.movedAux(channels,next)),'[1,12]');
assert.equal(helpers.movedAux(channels,channels.map(()=>0.01)).length,0);
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function text(t){return Array.isArray(t)?t.map(text).join(''):t&&typeof t==='object'?text(t.props?.children):String(t??'');}
const state={connected:true,reading:{link:'live',channels:next,armed:0,bench_active:0},changed:[12],error:''};
function render(override={},editable=true){
 const calls=[];
 const {ModeReceiver}=loadUiTs(path.resolve(__dirname,'../src/components/ModeReceiver.tsx'),{
  '../hooks/useModeReceiver':{...helpers,useModeReceiver:()=>({...state,...override})}
 });
 const tree=ModeReceiver({drafts:[{name:'ANGLE',aux:12,enabled:true,minUs:900,maxUs:1100}],editable,onAssign:(...args)=>calls.push(args)});
 return {tree,calls};
}
const ready=render();assert.equal(nodes(ready.tree).filter(n=>n.type==='meter').length,12);
assert.match(text(ready.tree),/AUX12 · CH16: 1000/);assert.match(text(ready.tree),/Inside draft range/);
nodes(ready.tree).find(n=>n.type==='button').props.onClick();assert.deepEqual(ready.calls,[['ANGLE',12]]);
for(const [override,editable] of [[{connected:false},true],[{reading:null},true],[{reading:{...state.reading,link:'lost'}},true],[{changed:[1,12]},true],[{reading:{...state.reading,armed:1}},true],[{},false]]){
 const p=render(override,editable),button=nodes(p.tree).find(n=>n.type==='button');
 assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(p.calls.length,0);
 if(!override.connected&&override.connected!==undefined||override.reading===null||override.reading?.link==='lost')assert.equal(nodes(p.tree).filter(n=>n.type==='meter').length,0);
}
// Real polling hook: no mutation commands, initial baseline does not identify a
// switch, and an outstanding response cannot repopulate an unmounted page.
async function main(){
 let value,cleanup,resolve;
 const commands=[];
 const hook=loadUiTs(hookPath,{
  react:{...realReact,useState:initial=>[value??initial,v=>{value=typeof v==='function'?v(value):v;}],useEffect:effect=>{cleanup=effect();}},
  './useHost':{useHost:()=>({connectionStatus:'connected',postFlashGate:false,host:{sendCommand:cmd=>{commands.push(cmd);return new Promise(r=>resolve=r);}}})},
  '../protocol/receiver':{parseReceiver:x=>x}
 });
 hook.useModeReceiver();assert.deepEqual(commands,['receiver']);
 resolve(state.reading);await new Promise(r=>setTimeout(r,0));
 assert.equal(value.changed.length,0);assert.equal(value.reading.link,'live');
 await new Promise(r=>setTimeout(r,800));
 assert.equal(value.reading,null);assert.match(value.error,/stopped/);cleanup();
 hook.useModeReceiver();cleanup();resolve(state.reading);await new Promise(r=>setTimeout(r,0));
 assert.equal(value.reading,null);
 console.log('PASS live Modes receiver: AUX indexing/units, movement threshold, draft assignment, locks, stale/disconnected hiding and late reply rejection');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
