/* SPDX-License-Identifier: Apache-2.0. Current schema only, incompatible records fail closed. */
const assert=require('node:assert/strict'),path=require('node:path'),p=require('../dist');
const {loadUiTs}=require('./load-ui-ts.cjs');
function storage(schema=13,scope=p.STORAGE_SCOPE_V13){return `storage_api: 1\nbackend: flash\nschema: ${schema}\nstate: saved\ndirty: 0\ngeneration: 2\nlast_error: none\nscope: ${scope}\narmed: 0\nbench_active: 0\ncalibration_active: 0\nflight_enabled: 0\nstorage_end: 1\n`;}
const current=p.parseStorage(storage());assert.equal(current.schema,13);assert.equal(p.STORAGE_PAYLOAD_BYTES_V13,256);assert(p.canSaveStorage(current,true,false));
for(let v=1;v<13;v++)assert.throws(()=>p.parseStorage(storage(v)),/Fresh install/);
assert.throws(()=>p.parseStorage(storage(14)),/Fresh install/);
for(const flag of ['armed','benchActive','calibrationActive'])assert(!p.canSaveStorage({...current,[flag]:true},true,false));
assert(!p.canSaveStorage({...current,lastError:'fresh_install_required',state:'error'},true,false));assert(!p.canSaveStorage({...current,backend:'host_sim'},true,false));assert(!p.canSaveStorage(current,false,false));assert(!p.canSaveStorage(current,true,true));
const dump=`# bobflight_config: 1\n# schema: 13\n# board: matek_f722_px\n# firmware: test-actual\n# kind: dump\n# mode_count: 4\n# scope: ${p.STORAGE_SCOPE_V13}\n# excludes: gyro_calibration\n# accel_calibrated: no\n# accel_bias: 0 0 0\n# accel_scale: 1 1 1\n# accel_storage: not-calibrated\n# calibration_restore: metadata-only-recalibrate-if-flash-lost\npower_config 11 0 0 0 3.5 3.3 0\ndshot 300\nset rate_max_roll 670\nset rate_center_roll 200\nset rate_expo_roll 0.5\nset motor_direction props-in\nset align_board_roll 180\nset loop_rate_hz 1000\nset gyro_notch1_cutoff_hz 100\nset gyro_notch1_hz 200\nset rpm_filter_harmonics 2\nset motor_poles 14\n# config_end: 1\n`;
assert.equal(p.parseConfigurationExport(dump,'dump').board,'matek_f722_px');
for(let v=1;v<=14;v++)if(v!==13)assert.throws(()=>p.parseConfigurationExport(dump.replace('# schema: 13',`# schema: ${v}`),'dump'));
for(const [from,to]of [['rate_center_roll 200','rate_center_roll -1'],['rate_center_roll 200','rate_center_roll 2001'],['rate_expo_roll 0.5','rate_expo_roll 1.1'],['align_board_roll 180','align_board_roll 181'],['motor_direction props-in','motor_direction nope'],['motor_poles 14','motor_poles 15'],['dshot 300','dshot 100'],['rate_expo_roll 0.5','rate_expo 0.5'],['rate_expo_roll 0.5','rate_type 1']])assert.throws(()=>p.parseConfigurationExport(dump.replace(from,to),'dump'));
assert.throws(()=>p.parseConfigurationExport(dump.replace('# config_end: 1','arm\n# config_end: 1'),'dump'));
const large=dump.replace('# config_end: 1','set rate_max_roll 800\n'.repeat(180)+'# config_end: 1');assert(large.length>p.CONFIG_EXPORT_MAX_BYTES);assert.throws(()=>p.parseConfigurationExport(large,'dump'),/limit/);
for(const cmd of ['set align_board_roll 180','get align_board_yaw'])assert(p.isBoardAlignmentCommand(cmd));
for(const cmd of ['set align_board_roll 181','set align_board_roll NaN','set align_board_roll 180\narm'])assert(!p.isBoardAlignmentCommand(cmd));
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function text(t){return Array.isArray(t)?t.map(text).join(''):t&&typeof t==='object'?text(t.props?.children):String(t??'');}
(async()=>{
 for(const blocked of [false,true]){
  let saves=0;const host={getConnectionStatus:()=> 'connected',sendCommand:async()=>storage(),saveSettings:async()=>{saves++;}};
  const react={...require('react'),useEffect:()=>{},useRef:v=>({current:v}),useState:v=>[v===null?current:v,()=>{}]};
  const {StoragePanel}=loadUiTs(path.resolve(__dirname,'../../ui/src/components/StoragePanel.tsx'),{react,'../protocol':p,'../hooks/useHost':{useHost:()=>({host,connectionStatus:'connected',postFlashGate:false})}});
  const b=nodes(StoragePanel({requiredScope:'power',blocked})).find(n=>n.type==='button'&&text(n)==='Save to controller');assert.equal(b.props.disabled,blocked);await b.props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,blocked?0:1);
 }
 console.log('PASS schema13 only: Actual export domains, old/future rejection, calibration metadata, save gates, mounting and bounded exports');
})().catch(e=>{console.error(e);process.exit(1);});
