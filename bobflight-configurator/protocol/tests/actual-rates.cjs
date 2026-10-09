/* SPDX-License-Identifier: Apache-2.0. Tests real rate helpers and RatesPage through explicit host/hook seams. */
const assert=require('node:assert/strict'),path=require('node:path');
const proto=require('../dist'),{loadUiTs}=require('./load-ui-ts.cjs');
const root=path.resolve(__dirname,'../../ui/src');
const math=loadUiTs(path.join(root,'tuning/actualRates.ts'),{'../protocol':proto});
const {RATES_DEFAULTS}=loadUiTs(path.join(root,'tuning/mockTuningStore.ts'));
const golden=[[0,79.375,217.5,414.375,670],[0,64.744873046875,162.421875,324.012451171875,670],[0,50.11474609375,107.34375,233.64990234375,670]];
for(let e=0;e<3;e++)for(let j=0;j<5;j++){assert.equal(math.actualRate(j/4,200,670,e/2),golden[e][j]);assert.equal(math.actualRate(-j/4,200,670,e/2)+golden[e][j],0);}
for(let e=0;e<=100;e++){assert(Math.abs(math.actualRate(1e-7,200,670,e/100)/1e-7-200)<1e-4);assert.equal(math.actualRate(1,200,670,e/100),670);assert.equal(math.actualRate(.5,400,200,e/100),200);}
assert.equal(math.actualRate(NaN,200,670,.5),0);assert.equal(math.actualRate(2,200,670,.5),670);
const draft={...RATES_DEFAULTS,rate_max_roll:670,rate_expo_roll:1};
assert(Math.abs(math.rateAtStick(draft,'roll',.51)-107.34375)<1e-8);assert.equal(math.rateAtStick(draft,'roll',.02),0);
assert.equal(math.rateSaveEntries(draft).length,9);assert(!math.rateSaveEntries(draft).some(([k])=>k==='rate_type'||k==='rate_expo'));
assert.throws(()=>math.rateSaveEntries({...draft,rate_expo_yaw:NaN},true));
const legacy={rate_max_roll:'555',rate_max_pitch:'800',rate_max_yaw:'700',rate_expo:'.42'};
assert.throws(()=>math.readRateSettings(legacy));assert.throws(()=>math.readRateSettings({...legacy,rate_type:'1'}));
const {parseCliInput}=loadUiTs(path.join(root,'protocol/types.ts'));
for(const cmd of ['get rate_center_roll','set rate_center_roll 0','set rate_expo_yaw .5'])assert.equal(parseCliInput(cmd),cmd);
for(const cmd of ['set rate_type 1','get rate_type','set rate_expo .3','set rate_type 2','set rate_type .5','set rate_center_roll -1','set rate_expo_yaw 2','set rate_type 1x','set rate_type 1\narm'])assert.equal(parseCliInput(cmd),null);
function storage(schema=13){return `storage_api: 1\nbackend: flash\nschema: ${schema}\nstate: saved\ndirty: 0\ngeneration: 2\nlast_error: none\nscope: ${proto.STORAGE_SCOPE_V13}\narmed: 0\nbench_active: 0\ncalibration_active: 0\nflight_enabled: 0\nstorage_end: 1\n`;}
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function text(t){return Array.isArray(t)?t.map(text).join(''):t&&typeof t==='object'?text(t.props?.children):String(t??'');}
async function scenario(kind){
 let state=[{...draft},true,false,false,true,proto.parseStorage(storage()),'',''],i=0,ref={current:0},writes=[],saves=0,connected=true,settings={...proto.DEFAULT_SETTINGS,...Object.fromEntries(Object.entries(draft).map(([k,v])=>[k,String(v)]))};
 if(kind==='old'){settings=legacy;}
 if(kind==='armed')state[5]={...state[5],armed:true};
 const host={getConnectionStatus:()=>connected?'connected':'disconnected',getAllSettings:async()=>{if(kind==='read-failure')throw Error('serial read failed');return settings;},sendCommand:async()=>storage(kind==='old'?11:13),setSetting:async(k,v)=>{writes.push([k,v]);if(kind==='write-failure'&&writes.length===2)throw Error('serial write failed');settings[k]=v;},saveSettings:async()=>{saves++;}};
 const react={...require('react'),useState:init=>{const n=i++;if(!(n in state))state[n]=typeof init==='function'?init():init;return[state[n],v=>state[n]=typeof v==='function'?v(state[n]):v];},useRef:()=>ref,useCallback:f=>f,useEffect:()=>{}};
 const {RatesPage}=loadUiTs(path.join(root,'pages/RatesPage.tsx'),{react,'../protocol':proto,'../hooks/useHost':{useHost:()=>({host,connectionStatus:'connected',postFlashGate:kind==='gated'})}});
 function render(){i=0;return RatesPage();}function button(label){return nodes(render()).find(n=>n.type==='button'&&text(n)===label);}
 if(kind==='ok'){
  const curve=nodes(render()).find(n=>n.type==='path'&&n.props['data-axis']==='roll').props.d.split(' ');assert(Number(curve[0].split(',')[1])>135&&Number(curve.at(-1).split(',')[1])<135);
  assert.equal(nodes(render()).filter(n=>n.type==='input').length,9);const expo=nodes(render()).find(n=>n.props?.id==='rate_expo_roll');expo.props.onChange({target:{value:'50'}});assert.equal(state[0].rate_expo_roll,.5);
  await button('Save to controller').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,1);assert.equal(writes.length,9);assert(!writes.some(([k])=>k==='rate_type'||k==='rate_expo'));assert.match(state[7],/Saved to controller flash/);
  writes=[];button('Reset rate draft').props.onClick();assert.equal(writes.length,0);assert.equal(state[0].rate_center_roll,200);assert(!nodes(render()).some(n=>n.type==='select'));
 }else if(kind==='old'){button('Reload controller').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(state[1],false);assert.equal(writes.length,0);assert(button('Save to controller').props.disabled);assert.match(state[6],/Fresh-install/);}
 else if(kind==='write-failure'){await button('Save to controller').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,0);assert.equal(writes.length,2);assert.equal(state[1],false);assert.match(state[6],/Some values may already/);}
 else if(kind==='read-failure'){button('Reload controller').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(state[1],false);assert.equal(state[3],false);assert.equal(writes.length,0);assert(button('Save to controller').props.disabled);}
 else {assert(button('Save to controller').props.disabled);await button('Save to controller').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(writes.length,0);}
}
(async()=>{for(const s of ['ok','old','write-failure','read-failure','armed','gated'])await scenario(s);console.log('PASS Actual math, units, per-axis UI, signed preview, nine-key saves, old firmware rejected, flash guards, partial-write failure, no fake fallback, rate-only draft reset');})().catch(e=>{console.error(e);process.exit(1);});
