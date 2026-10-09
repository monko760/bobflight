/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');const path=require('node:path');
const {parseStorage,parseModes,parseConfigurationExport,parseSaveReply,canSaveStorage,CONFIG_EXPORT_MAX_BYTES}=require('../../bobflight-configurator/protocol/dist');
const RPM=',rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles';
/* Same export as a schema 8 FW would write: no RPM scope/lines. */
const MD=',motor_direction';
const MOUNT=',align_board_roll,align_board_pitch,align_board_yaw';
const v10=raw=>raw.replace('# schema: 11','# schema: 10').replace(MOUNT,'').replace(/set align_board_(?:roll|pitch|yaw) \S+\r\n/g,'');
/* Same export as a schema 9 FW would write: no motor_direction scope/line. */
const v9=raw=>v10(raw).replace('# schema: 10','# schema: 9').replace(MD,'').replace(/set motor_direction \S+\r\n/g,'');
const v8=raw=>v9(raw).replace('# schema: 9','# schema: 8').replace(RPM,'').replace(/set (?:rpm_filter_\w+|motor_poles) \S+\r\n/g,'');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const commands=['storage','diff all','dump all','mode_range ACRO 1 5 1300 1600','mode_range HORIZON 1 6 1600 1900','control_mode horizon','control_source aux','power_config 12.25 27.5 100 6 3.6 3.2 1500','dshot 600','storage','save','storage','diff all','dump all','modes'];
const run=spawnSync(binary,[],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024});assert.equal(run.status,0,run.stderr);
const states=[...run.stdout.matchAll(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/g)].map(m=>parseStorage(m[0]));
assert.equal(states.length,3);assert.equal(states[0].state,'defaults');assert.equal(states[1].dirty,true);assert.equal(states[2].state,'saved');assert.equal(states[2].dirty,false);assert.equal(states[2].backend,'host_sim');assert.equal(canSaveStorage(states[2],true,false),false,'simulation must not offer physical flash save');
const backups=[...run.stdout.matchAll(/# bobflight_config: 1\r?\n[\s\S]*?# config_end: 1\r?\n/g)].map((m,i)=>parseConfigurationExport(m[0],i%2?'dump':'diff'));
assert.equal(backups.length,4);assert.match(backups[3].raw,/power_config 12.25 27.5 100 6/);assert.match(backups[3].raw,/dshot 600/);assert(!backups[0].raw.includes('\r\nmode_range '));assert.equal(backups[3].modeCount,4);
for(const command of ['mode_range ACRO 1 5 1300 1600','mode_range HORIZON 1 6 1600 1900','control_mode horizon'])assert(backups[2].raw.includes(command+'\r\n'));
for(const e of backups){assert.equal(CONFIG_EXPORT_MAX_BYTES,2560);assert(Buffer.byteLength(e.raw)<CONFIG_EXPORT_MAX_BYTES);assert(!e.raw.includes('\r\narm\r\n'));assert(!e.raw.includes('\r\nsave\r\n'));}
assert(!parseSaveReply('saved\r\n').ok);assert(!parseSaveReply('saved: host_sim verified\r\n').ok);assert(parseSaveReply('saved: flash verified\r\n').ok);
assert.equal(states[2].schema,11);assert.match(states[2].scope,/,loop_rate_hz,gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz,rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles,motor_direction,align_board_roll,align_board_pitch,align_board_yaw$/);
for(const invalid of ['storage_api: 1\r\n',run.stdout.match(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/)[0].replace('schema: 11','schema: 12')]){if(invalid!==undefined)assert.throws(()=>parseStorage(invalid));}
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('# schema: 11','# schema: 12'),'dump'));
// Schema 10 motor_direction: dump carries it right after motor_poles, diff omits the default props-out; a schema 9 export cannot carry it.
assert.match(backups[3].raw,/\r\nset motor_poles 14\r\nset align_board_roll 0\r\nset align_board_pitch 0\r\nset align_board_yaw 0\r\nset motor_direction props-out\r\n/);assert(!/set motor_direction/.test(backups[0].raw),'diff omits the default props-out');
assert.throws(()=>parseConfigurationExport(v10(backups[3].raw).replace('# schema: 10','# schema: 9').replace(MD,''),'dump'),'schema 9 export cannot carry motor_direction');
assert.doesNotThrow(()=>parseConfigurationExport(v9(backups[3].raw),'dump'),'schema 9 export without the motor_direction line stays valid');
for(const bad of ['set motor_direction props-mixed','set motor_direction 1','set motor_direction PROPS-IN'])assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('set motor_direction props-out',bad),'dump'),bad);
assert.doesNotThrow(()=>parseConfigurationExport(backups[3].raw.replace('set motor_direction props-out','set motor_direction props-in'),'dump'));
assert.match(backups[3].raw,/\r\nset loop_rate_hz (1000|4000|8000)\r\n/);assert(!/set loop_rate_hz/.test(backups[0].raw),'diff omits the board-default loop rate');
for(const bad of ['set loop_rate_hz 2000','set loop_rate_hz 4000.0'])assert.throws(()=>parseConfigurationExport(backups[3].raw.replace(/set loop_rate_hz \d+/,bad),'dump'));
assert.throws(()=>parseConfigurationExport(v8(backups[3].raw).replace('# schema: 8','# schema: 6').replace(',loop_rate_hz,gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz',''),'dump'),'schema 6 export cannot carry loop_rate_hz');
// Schema 8 manual gyro notches: dump carries all four (cutoff before centre), diff omits the default-off pairs; a schema 7 export cannot carry them.
assert.match(backups[3].raw,/\r\nset gyro_notch1_cutoff_hz 0\r\nset gyro_notch1_hz 0\r\nset gyro_notch2_cutoff_hz 0\r\nset gyro_notch2_hz 0\r\n/);assert(!/set gyro_notch/.test(backups[0].raw),'diff omits default-off notches');
assert.throws(()=>parseConfigurationExport(v8(backups[3].raw).replace('# schema: 8','# schema: 7').replace(',gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz',''),'dump'),'schema 7 export cannot carry gyro notch lines');
assert.doesNotThrow(()=>parseConfigurationExport(v8(backups[3].raw).replace('# schema: 8','# schema: 7').replace(',gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz','').replace(/set gyro_notch\S+ \S+\r\n/g,''),'dump'),'schema 7 export without notch lines stays valid');
for(const bad of ['set gyro_notch1_hz 10','set gyro_notch1_hz 1200','set gyro_notch1_hz -1'])assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('set gyro_notch1_hz 0',bad),'dump'),bad);
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('set gyro_notch2_cutoff_hz 0','set gyro_notch2_cutoff_hz 1000'),'dump'));
// Schema 9 RPM filter: dump carries all four whole numbers, diff omits defaults; a schema 8 export cannot carry them.
assert.match(backups[3].raw,/\r\nset rpm_filter_harmonics 0\r\nset rpm_filter_min_hz 100\r\nset rpm_filter_q_x100 500\r\nset motor_poles 14\r\n/);assert(!/set (rpm_filter|motor_poles)/.test(backups[0].raw),'diff omits default RPM filter');
assert.throws(()=>parseConfigurationExport(v9(backups[3].raw).replace('# schema: 9','# schema: 8').replace(RPM,''),'dump'),'schema 8 export cannot carry RPM filter lines');
assert.doesNotThrow(()=>parseConfigurationExport(v8(backups[3].raw),'dump'),'schema 8 export without RPM lines stays valid');
const rpmDefault={rpm_filter_harmonics:'0',rpm_filter_min_hz:'100',rpm_filter_q_x100:'500',motor_poles:'14'};
for(const bad of ['set rpm_filter_harmonics 4','set rpm_filter_harmonics 1.5','set rpm_filter_min_hz 49','set rpm_filter_q_x100 1001','set motor_poles 13','set motor_poles 38']){const key=bad.split(' ')[1];assert.throws(()=>parseConfigurationExport(backups[3].raw.replace(`set ${key} ${rpmDefault[key]}`,bad),'dump'),bad);}
assert.doesNotThrow(()=>parseConfigurationExport(backups[3].raw.replace('set rpm_filter_harmonics 0','set rpm_filter_harmonics 3').replace('set motor_poles 14','set motor_poles 36'),'dump'));
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('# config_end: 1','arm\r\n# config_end: 1'),'dump'));
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('mode_range HORIZON 1 6 1600 1900','mode_range HORIZON 1 257 1600 1900'),'dump'));
const actual=run.stdout.match(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/)[0];
const ready=parseStorage(actual.replace('backend: host_sim','backend: flash'));
assert(canSaveStorage(ready,true,false));assert(canSaveStorage({...ready,flightEnabled:true},true,false));for(const key of ['armed','benchActive','calibrationActive'])assert(!canSaveStorage({...ready,[key]:true},true,false));assert(!canSaveStorage(ready,false,false));assert(!canSaveStorage(ready,true,true));
console.log('PASS real firmware → storage/export parsers: four modes, Horizon + manual selection, unsupported AUX refusal, defaults/deltas, dirty/verified simulation distinction, unsafe save locks, legacy/truncated/invalid exports, no arm/save in backups');

assert.match(run.stdout,/control_source refused: manual only/);
assert.match(backups[3].raw,/control_source manual\r\n/);
assert(!backups[3].raw.includes('control_source aux'));
console.log('PASS refused AUX command cannot corrupt saved manual source; Save remains available in main image while disarmed');

// Mounting keys are current schema only; retain strict old/future-schema boundaries.
assert.doesNotThrow(()=>parseConfigurationExport(v10(backups[3].raw),'dump'));
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('# schema: 11','# schema: 10').replace(MOUNT,''),'dump'),'schema10 cannot carry mounting keys');
assert(!/set align_board_/.test(backups[0].raw),'default mounting omitted from diff');
for(const invalid of ['181','-181','0.5','NaN'])assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('set align_board_roll 0','set align_board_roll '+invalid),'dump'));
const mount=spawnSync(binary,[],{input:'set align_board_roll 180\nset align_board_yaw 90\ndiff all\ndump all\nsave\nstorage\n',encoding:'utf8',maxBuffer:1024*1024});assert.equal(mount.status,0,mount.stderr);
for(const [i,m] of [...mount.stdout.matchAll(/# bobflight_config: 1\r?\n[\s\S]*?# config_end: 1\r?\n/g)].entries()){
 const exp=parseConfigurationExport(m[0],i?'dump':'diff');assert.match(exp.raw,/set align_board_roll 180\r?\n/);assert.match(exp.raw,/set align_board_yaw 90\r?\n/);
}
assert.match(mount.stdout,/saved: host_sim verified/);assert.match(mount.stdout,/state: saved/);
console.log('PASS actual schema11 mounting exports and Save, bounded current domain, preserved schema10/9/8 compatibility and unknown-schema refusal');
