/* SPDX-License-Identifier: Apache-2.0. Current schema only, incompatible records fail closed. */
const assert=require('node:assert/strict'),path=require('node:path'),p=require('../dist');
const {loadUiTs}=require('./load-ui-ts.cjs');
function storage(schema=14,scope=p.STORAGE_SCOPE_V14,stored='14'){return `storage_api: 1\nbackend: flash\nschema: ${schema}\nstate: saved\ndirty: 0\ngeneration: 2\nlast_error: none\nscope: ${scope}\narmed: 0\nbench_active: 0\ncalibration_active: 0\nflight_enabled: 0\naccel_cal_saved: no\nstored_schema: ${stored}\nstorage_end: 1\n`;}
const current=p.parseStorage(storage());assert.equal(current.schema,14);assert.equal(current.storedSchema,'14');assert.equal(p.STORAGE_PAYLOAD_BYTES_V13,256);assert(p.canSaveStorage(current,true,false));
for(let v=1;v<13;v++)assert.throws(()=>p.parseStorage(storage(v)),/Fresh install/);
// N3: schema 13 firmware is a firmware update (settings carry over after the update), never 'Fresh install required'.
{let err;try{p.parseStorage(storage(13,p.STORAGE_SCOPE_V13));}catch(e){err=e;}assert(err instanceof p.StorageFirmwareUpdateError,String(err));assert.doesNotMatch(err.message,/Fresh install/i);
 assert.equal(p.STORAGE_FIRMWARE_UPDATE_TEXT,'After the firmware update, saved schema 13 settings carry over and the next Save rewrites them as schema 14.');
 assert.equal(err.message,'Firmware update needed: the controller reports storage schema 13; this Configurator needs storage schema 14. After the firmware update, saved schema 13 settings carry over and the next Save rewrites them as schema 14.');}
// N3 stored_schema 13 (migrated, not yet rewritten) is a normal saved snapshot; Save stays available.
{const migrated=p.parseStorage(storage(14,p.STORAGE_SCOPE_V14,'13'));assert.equal(migrated.storedSchema,'13');assert(p.canSaveStorage(migrated,true,false));}
// newer_settings: error state over a schema 14 record, Save refused; any other pairing is contradictory.
{const newer=p.parseStorage(storage(14).replace('state: saved','state: error').replace('dirty: 0','dirty: 1').replace('last_error: none','last_error: newer_settings'));
 assert.equal(newer.lastError,'newer_settings');assert(!p.canSaveStorage(newer,true,false),'newer_settings refuses Save');
 assert.throws(()=>p.parseStorage(storage(14,p.STORAGE_SCOPE_V14,'13').replace('state: saved','state: error').replace('dirty: 0','dirty: 1').replace('last_error: none','last_error: newer_settings')),/contradictory/,'newer_settings over a schema 13 record');
 assert.throws(()=>p.parseStorage(storage(14).replace('state: saved','state: dirty').replace('dirty: 0','dirty: 1').replace('last_error: none','last_error: newer_settings')),/contradictory/,'newer_settings outside the error state');
 assert.throws(()=>p.parseStorage(storage(14,p.STORAGE_SCOPE_V14,'none')),/contradictory/,'saved with nothing stored');
 assert.equal(p.parseStorage(storage(14,p.STORAGE_SCOPE_V14,'none').replace('state: saved','state: defaults').replace('dirty: 0','dirty: 1')).storedSchema,'none');
 for(const v of ['12','15','','14 ','NONE'])assert.throws(()=>p.parseStorage(storage(14,p.STORAGE_SCOPE_V14,v)),/stored_schema/);
 assert.throws(()=>p.parseStorage(storage().replace('stored_schema: 14\n','')),/missing stored_schema/);}
assert.equal(p.STORAGE_DOWNGRADE_NOTE,'After this Save, older (schema 13) firmware would load the previous saved copy; after a second Save it would start from defaults. Back up with diff all first.');
assert.equal(p.STORAGE_NEWER_SETTINGS_TEXT,'Settings were written by newer firmware. Update firmware to change them; Save is refused so nothing is lost.');
// F5: a newer schema or a scope/parse mismatch is an unreadable reply (raw kept), never 'Fresh install required'.
for(const bad of [storage(15),storage(14,'pid_rates'),storage(14).replace('backend: flash','backend: eeprom'),storage(14).replace('storage_end: 1\n',''),'garbage\n']){let err;try{p.parseStorage(bad);}catch(e){err=e;}assert(err instanceof p.StorageReplyError,String(err));assert.match(err.message,/^Storage reply could not be read: /);assert.doesNotMatch(err.message,/Fresh install/i);assert.equal(err.raw,bad);}
for(const flag of ['armed','benchActive','calibrationActive'])assert(!p.canSaveStorage({...current,[flag]:true},true,false));
assert(!p.canSaveStorage({...current,lastError:'fresh_install_required',state:'error'},true,false));assert(!p.canSaveStorage({...current,backend:'host_sim'},true,false));assert(!p.canSaveStorage(current,false,false));assert(!p.canSaveStorage(current,true,true));
const dump=`# bobflight_config: 1\n# schema: 14\n# board: matek_f722_px\n# firmware: test-actual\n# kind: dump\n# mode_count: 4\n# scope: ${p.STORAGE_SCOPE_V14}\n# excludes: gyro_calibration\n# accel_calibrated: no\n# accel_bias: 0 0 0\n# accel_scale: 1 1 1\n# accel_storage: not-calibrated\n# calibration_restore: metadata-only-recalibrate-if-flash-lost\npower_config 11 0 0 0 3.5 3.3 0\ndshot 300\nset rate_max_roll 670\nset rate_center_roll 200\nset rate_expo_roll 0.5\nset motor_direction props-in\nset align_board_roll 180\nset loop_rate_hz 1000\nset gyro_notch1_cutoff_hz 100\nset gyro_notch1_hz 200\nset rpm_filter_harmonics 2\nset motor_poles 14\n# config_end: 1\n`;
assert.equal(p.parseConfigurationExport(dump,'dump').board,'matek_f722_px');
for(let v=1;v<=15;v++)if(v!==13&&v!==14)assert.throws(()=>p.parseConfigurationExport(dump.replace('# schema: 14',`# schema: ${v}`),'dump'),/Unsupported export identity\/schema|Unexpected power\/motor setting|Invalid exported|Fresh install required: schema 13 only/);
assert.equal(p.parseConfigurationExport(dump.replace('# schema: 14','# schema: 13'),'dump').board,'matek_f722_px','N3: schema 13 backups import');
for(const [from,to]of [['rate_center_roll 200','rate_center_roll -1'],['rate_center_roll 200','rate_center_roll 2001'],['rate_expo_roll 0.5','rate_expo_roll 1.1'],['align_board_roll 180','align_board_roll 181'],['motor_direction props-in','motor_direction nope'],['motor_poles 14','motor_poles 15'],['dshot 300','dshot 100'],['rate_expo_roll 0.5','rate_expo 0.5'],['rate_expo_roll 0.5','rate_type 1']])assert.throws(()=>p.parseConfigurationExport(dump.replace(from,to),'dump'));
assert.throws(()=>p.parseConfigurationExport(dump.replace('# config_end: 1','arm\n# config_end: 1'),'dump'));
const large=dump.replace('# config_end: 1','set rate_max_roll 800\n'.repeat(180)+'# config_end: 1');assert(large.length>p.CONFIG_EXPORT_MAX_BYTES);assert.throws(()=>p.parseConfigurationExport(large,'dump'),/limit/);
for(const cmd of ['set align_board_roll 180','get align_board_yaw'])assert(p.isBoardAlignmentCommand(cmd));
for(const cmd of ['set align_board_roll 181','set align_board_roll NaN','set align_board_roll 180\narm'])assert(!p.isBoardAlignmentCommand(cmd));
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
function text(t){return Array.isArray(t)?t.map(text).join(''):t&&typeof t==='object'?text(t.props?.children):String(t??'');}
(async()=>{
 for(const blocked of [false,true]){
  // PR 2: the panel sends `save` inside its storage sequence (one gated run on hosts that offer it) and requires the FW's verified reply.
  let saves=0;const host={getConnectionStatus:()=> 'connected',sendCommand:async(c)=>{if(c==='save'){saves++;return 'saved: flash verified\r\n';}return storage();},saveSettings:async()=>{throw Error('StoragePanel must not use saveSettings()');}};
  const react={...require('react'),useEffect:()=>{},useRef:v=>({current:v}),useState:v=>[v===null?current:v,()=>{}]};
  const {StoragePanel}=loadUiTs(path.resolve(__dirname,'../../ui/src/components/StoragePanel.tsx'),{react,'../protocol':p,'../hooks/useHost':{useHost:()=>({host,connectionStatus:'connected',postFlashGate:false})}});
  const b=nodes(StoragePanel({requiredScope:'power',blocked})).find(n=>n.type==='button'&&text(n)==='Save to controller');assert.equal(b.props.disabled,blocked);await b.props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saves,blocked?0:1);
 }
 console.log('PASS schema14 (+schema 13 import / firmware-update, stored_schema, newer_settings): Actual export domains, old/future rejection, calibration metadata, save gates, mounting and bounded exports');
})().catch(e=>{console.error(e);process.exit(1);});
