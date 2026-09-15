/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {parseStorage,canSaveStorage,parseConfigurationExport,STORAGE_SCOPE,STORAGE_SCOPE_V2,STORAGE_SCOPE_V3}=require('../dist');
const {mockSensorReply}=require('../dist/sensor-mock');
const {loadUiTs}=require('./load-ui-ts.cjs');
const {parseKeyValueSnapshot}=loadUiTs(path.resolve(__dirname,'../../ui/src/sensors/telemetry.ts'));
function storage(schema,scope){return `storage_api: 1\nbackend: flash\nschema: ${schema}\nstate: saved\ndirty: 0\ngeneration: 2\nlast_error: none\nscope: ${scope}\narmed: 0\nbench_active: 0\ncalibration_active: 0\nflight_enabled: 0\nstorage_end: 1\n`;}
for(const [schema,scope] of [[1,STORAGE_SCOPE],[2,STORAGE_SCOPE_V2],[3,STORAGE_SCOPE_V3]]){
 const s=parseStorage(storage(schema,scope));assert.equal(s.schema,schema);assert(canSaveStorage(s,true,false));
 for(const key of ['armed','benchActive','calibrationActive'])assert(!canSaveStorage({...s,[key]:true},true,false));
 assert(canSaveStorage({...s,flightEnabled:true},true,false)); /* unified flight firmware: flight-enabled configuration is legitimately saveable */
 assert(!canSaveStorage({...s,backend:'host_sim'},true,false));
}
assert.throws(()=>parseStorage(storage(3,STORAGE_SCOPE_V2)));
assert.throws(()=>parseStorage(storage(2,STORAGE_SCOPE)));
const base=mockSensorReply('sensors');
for(const state of ['ram-only','not-calibrated','error','unsaved','flash-verified','host-sim']){
 const valid=['unsaved','flash-verified','host-sim'].includes(state);
 const text=base.replace('calibration_storage: ram-only',`calibration_storage: ${state}`).replace('accel_calibrated: no',`accel_calibrated: ${valid?'yes':'no'}`);
 assert.equal(parseKeyValueSnapshot(text).calibration_storage,state);
}
assert.equal(parseKeyValueSnapshot(base.replace('calibration_storage: ram-only','calibration_storage: pretend-saved')),null);
const backup=`# bobflight_config: 1\n# schema: 2\n# board: kakute_f7_hdv\n# firmware: bench-test\n# kind: dump\n# mode_count: 4\n# scope: ${STORAGE_SCOPE_V2}\n# excludes: gyro_calibration,power,dshot\n# accel_calibrated: yes\n# accel_bias: 0 0 -0.2\n# accel_scale: 1 1 1\n# accel_storage: flash-verified\n# calibration_restore: metadata-only-recalibrate-if-flash-lost\nset rate_max_roll 800\n# config_end: 1\n`;
assert.equal(parseConfigurationExport(backup,'dump').board,'kakute_f7_hdv');
for(const bad of [backup.replace('0 0 -0.2','0 0 NaN'),backup.replace('1 1 1','1 0.1 1'),backup.replace('# schema: 2','# schema: 3'),backup.replace('# config_end: 1','calibrate_accel apply\n# config_end: 1')])assert.throws(()=>parseConfigurationExport(bad,'dump'));
console.log('PASS schema1/2 compatibility, honest calibration-storage states, flash-only save guards, bounded metadata exports without calibration replay');

const v3=backup.replace('# schema: 2','# schema: 3').replace(STORAGE_SCOPE_V2,STORAGE_SCOPE_V3).replace('# excludes: gyro_calibration,power,dshot','# excludes: gyro_calibration').replace('# config_end: 1','power_config 12.25 27.5 100 6 3.6 3.2 1500\ndshot 600\n# config_end: 1');
assert.equal(parseConfigurationExport(v3,'dump').board,'kakute_f7_hdv');
for(const bad of [v3.replace('dshot 600','dshot 1200'),v3.replace('12.25 27.5','NaN 27.5'),v3.replace('3.6 3.2','3.0 3.2'),v3.replace('100 6','100 7')])assert.throws(()=>parseConfigurationExport(bad,'dump'));
console.log('PASS schema3 capability + bounded power/DShot export validation');

// Render the actual save panel with old/new advertised capabilities.
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function txt(t){return Array.isArray(t)?t.map(txt).join(''):t&&typeof t==='object'?txt(t.props?.children):String(t??'');}
(async()=>{
 for(const [schema,scope,allowed] of [[2,STORAGE_SCOPE_V2,false],[3,STORAGE_SCOPE_V3,true]]){
  let saves=0;
  const state=parseStorage(storage(schema,scope));
  const host={getConnectionStatus:()=> 'connected',sendCommand:async()=>storage(schema,scope),saveSettings:async()=>{saves++;}};
  const react={...require('react'),useEffect:()=>{},useRef:v=>({current:v}),useState:v=>[v===null?state:v,()=>{}]};
  const {StoragePanel}=loadUiTs(path.resolve(__dirname,'../../ui/src/components/StoragePanel.tsx'),{react,'../protocol':require('../dist'),'../hooks/useHost':{useHost:()=>({host,connectionStatus:'connected',postFlashGate:false})}});
  const button=nodes(StoragePanel({requiredScope:'power'})).find(n=>n.type==='button'&&txt(n)==='Save to controller');
  assert.equal(button.props.disabled,!allowed);await button.props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,allowed?1:0);
  const blocked=nodes(StoragePanel({requiredScope:'power',blocked:true})).find(n=>n.type==='button'&&txt(n)==='Save to controller');
  assert.equal(blocked.props.disabled,true);await blocked.props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,allowed?1:0);
 }
 console.log('PASS real StoragePanel: old firmware cannot save power, schema3 explicit save, unapplied-draft lock');
})().catch(e=>{console.error(e);process.exit(1);});
