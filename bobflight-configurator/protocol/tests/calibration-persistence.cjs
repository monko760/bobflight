/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {parseStorage,canSaveStorage,parseConfigurationExport,STORAGE_SCOPE,STORAGE_SCOPE_V2,STORAGE_SCOPE_V3,STORAGE_SCOPE_V4,STORAGE_SCOPE_V5,STORAGE_SCOPE_V6,STORAGE_SCOPE_V7,STORAGE_SCOPE_V8,STORAGE_PAYLOAD_BYTES_V8,STORAGE_SCOPE_V9,STORAGE_PAYLOAD_BYTES_V9,CONFIG_EXPORT_MAX_BYTES}=require('../dist');
const {mockSensorReply}=require('../dist/sensor-mock');
const {loadUiTs}=require('./load-ui-ts.cjs');
const {parseKeyValueSnapshot}=loadUiTs(path.resolve(__dirname,'../../ui/src/sensors/telemetry.ts'));
function storage(schema,scope){return `storage_api: 1\nbackend: flash\nschema: ${schema}\nstate: saved\ndirty: 0\ngeneration: 2\nlast_error: none\nscope: ${scope}\narmed: 0\nbench_active: 0\ncalibration_active: 0\nflight_enabled: 0\nstorage_end: 1\n`;}
for(const [schema,scope] of [[1,STORAGE_SCOPE],[2,STORAGE_SCOPE_V2],[3,STORAGE_SCOPE_V3],[4,STORAGE_SCOPE_V4],[5,STORAGE_SCOPE_V5],[6,STORAGE_SCOPE_V6],[7,STORAGE_SCOPE_V7]]){
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
const v4=v3.replace('# schema: 3','# schema: 4').replace(STORAGE_SCOPE_V3,STORAGE_SCOPE_V4);
assert.equal(parseConfigurationExport(v4,'dump').modeCount,4);
console.log('PASS schema4 capability (min_throttle/airmode scope)');
const v5=v4.replace('# schema: 4','# schema: 5').replace(STORAGE_SCOPE_V4,STORAGE_SCOPE_V5);
assert.equal(parseConfigurationExport(v5,'dump').modeCount,4);
console.log('PASS schema5 capability (gyro/dterm LPF scope)');
const v6=v5.replace('# schema: 5','# schema: 6').replace(STORAGE_SCOPE_V5,STORAGE_SCOPE_V6);
assert.equal(parseConfigurationExport(v6,'dump').modeCount,4);
console.log('PASS schema6 capability (pid_yaw_d @ 184..187 / 188-byte payload)');
const v7=v6.replace('# schema: 6','# schema: 7').replace(STORAGE_SCOPE_V6,STORAGE_SCOPE_V7).replace('# config_end: 1','set loop_rate_hz 8000\n# config_end: 1');
assert.equal(parseConfigurationExport(v7,'dump').modeCount,4);
for(const bad of [v7.replace('set loop_rate_hz 8000','set loop_rate_hz 2000'),v7.replace('set loop_rate_hz 8000','set loop_rate_hz 8000.0'),v6.replace('# config_end: 1','set loop_rate_hz 4000\n# config_end: 1')])assert.throws(()=>parseConfigurationExport(bad,'dump'));
assert.throws(()=>parseStorage(storage(7,STORAGE_SCOPE_V6)));assert.throws(()=>parseStorage(storage(6,STORAGE_SCOPE_V7)));
console.log('PASS schema7 capability (loop_rate_hz 1000|4000|8000 @ 188..191 / 192-byte payload)');
const v8=v7.replace('# schema: 7','# schema: 8').replace(STORAGE_SCOPE_V7,STORAGE_SCOPE_V8).replace('# config_end: 1','set gyro_notch1_cutoff_hz 150\nset gyro_notch1_hz 200\nset gyro_notch2_cutoff_hz 0\nset gyro_notch2_hz 0\n# config_end: 1');
assert.equal(parseConfigurationExport(v8,'dump').modeCount,4);assert.equal(STORAGE_PAYLOAD_BYTES_V8,208);
assert.equal(STORAGE_SCOPE_V8,STORAGE_SCOPE_V7+',gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz');
for(const bad of [v8.replace('set gyro_notch1_hz 200','set gyro_notch1_hz 10'),v8.replace('set gyro_notch1_hz 200','set gyro_notch1_hz 1001'),v8.replace('set gyro_notch2_cutoff_hz 0','set gyro_notch2_cutoff_hz 1000'),v7.replace('# config_end: 1','set gyro_notch1_hz 0\n# config_end: 1')])assert.throws(()=>parseConfigurationExport(bad,'dump'));
assert.equal(parseStorage(storage(8,STORAGE_SCOPE_V8)).schema,8);assert.throws(()=>parseStorage(storage(8,STORAGE_SCOPE_V7)));assert.throws(()=>parseStorage(storage(7,STORAGE_SCOPE_V8)));assert.throws(()=>parseStorage(storage(9,STORAGE_SCOPE_V8)));
console.log('PASS schema8 capability (gyro_notch1/2 centre+cutoff @ 192..207 / 208-byte payload)');
const v9=v8.replace('# schema: 8','# schema: 9').replace(STORAGE_SCOPE_V8,STORAGE_SCOPE_V9).replace('# config_end: 1','set rpm_filter_harmonics 3\nset rpm_filter_min_hz 100\nset rpm_filter_q_x100 500\nset motor_poles 14\n# config_end: 1');
assert.equal(parseConfigurationExport(v9,'dump').modeCount,4);assert.equal(STORAGE_PAYLOAD_BYTES_V9,224);assert.equal(CONFIG_EXPORT_MAX_BYTES,2048);
assert.equal(STORAGE_SCOPE_V9,STORAGE_SCOPE_V8+',rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles');
for(const bad of [v9.replace('set rpm_filter_harmonics 3','set rpm_filter_harmonics 4'),v9.replace('set rpm_filter_harmonics 3','set rpm_filter_harmonics 2.5'),v9.replace('set rpm_filter_min_hz 100','set rpm_filter_min_hz 201'),
  v9.replace('set rpm_filter_q_x100 500','set rpm_filter_q_x100 99'),v9.replace('set motor_poles 14','set motor_poles 15'),v9.replace('set motor_poles 14','set motor_poles 40'),v8.replace('# config_end: 1','set motor_poles 14\n# config_end: 1')])assert.throws(()=>parseConfigurationExport(bad,'dump'));
{const pad='# config_end: 1';const big=v9.replace(pad,'set rate_max_roll 800\n'.repeat(Math.ceil((CONFIG_EXPORT_MAX_BYTES-v9.length)/22)+1)+pad);assert(big.length>CONFIG_EXPORT_MAX_BYTES);assert.throws(()=>parseConfigurationExport(big,'dump'),e=>e.message===`Configuration export is ${big.length} bytes; the limit is 2048 bytes`,'oversize message states the actual size and the 2048 limit');
 const fits=v9.replace(pad,'set rate_max_roll 800\n'.repeat(Math.floor((1990-v9.length)/22))+pad);assert(fits.length>1800&&fits.length<=CONFIG_EXPORT_MAX_BYTES);assert.equal(parseConfigurationExport(fits,'dump').modeCount,4);}
assert.equal(parseStorage(storage(9,STORAGE_SCOPE_V9)).schema,9);assert.throws(()=>parseStorage(storage(9,STORAGE_SCOPE_V8)));assert.throws(()=>parseStorage(storage(8,STORAGE_SCOPE_V9)));assert.throws(()=>parseStorage(storage(10,STORAGE_SCOPE_V9)));
console.log('PASS schema9 capability (RPM filter harmonics/min_hz/q_x100/motor_poles @ 208..223 / 224-byte payload; export limit 2048)');

// Render the actual save panel with old/new advertised capabilities.
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function txt(t){return Array.isArray(t)?t.map(txt).join(''):t&&typeof t==='object'?txt(t.props?.children):String(t??'');}
(async()=>{
 for(const [schema,scope,allowed] of [[2,STORAGE_SCOPE_V2,false],[3,STORAGE_SCOPE_V3,true],[4,STORAGE_SCOPE_V4,true],[5,STORAGE_SCOPE_V5,true],[6,STORAGE_SCOPE_V6,true],[7,STORAGE_SCOPE_V7,true],[8,STORAGE_SCOPE_V8,true],[9,STORAGE_SCOPE_V9,true]]){
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
