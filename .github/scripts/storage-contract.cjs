/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');const path=require('node:path');
const {parseStorage,parseModes,parseConfigurationExport,parseSaveReply,canSaveStorage}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const commands=['storage','diff all','dump all','mode_range ACRO 1 5 1300 1600','mode_range HORIZON 1 6 1600 1900','control_mode horizon','control_source aux','storage','save','storage','diff all','dump all','modes'];
const run=spawnSync(binary,[],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024});assert.equal(run.status,0,run.stderr);
const states=[...run.stdout.matchAll(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/g)].map(m=>parseStorage(m[0]));
assert.equal(states.length,3);assert.equal(states[0].state,'defaults');assert.equal(states[1].dirty,true);assert.equal(states[2].state,'saved');assert.equal(states[2].dirty,false);assert.equal(states[2].backend,'host_sim');assert.equal(canSaveStorage(states[2],true,false),false,'simulation must not offer physical flash save');
const backups=[...run.stdout.matchAll(/# bobflight_config: 1\r?\n[\s\S]*?# config_end: 1\r?\n/g)].map((m,i)=>parseConfigurationExport(m[0],i%2?'dump':'diff'));
assert.equal(backups.length,4);assert(!backups[0].raw.includes('\r\nmode_range '));assert.equal(backups[3].modeCount,4);
for(const command of ['mode_range ACRO 1 5 1300 1600','mode_range HORIZON 1 6 1600 1900','control_mode horizon','control_source aux'])assert(backups[2].raw.includes(command+'\r\n'));
for(const e of backups){assert(Buffer.byteLength(e.raw)<1800);assert(!e.raw.includes('\r\narm\r\n'));assert(!e.raw.includes('\r\nsave\r\n'));}
assert(!parseSaveReply('saved\r\n').ok);assert(!parseSaveReply('saved: host_sim verified\r\n').ok);assert(parseSaveReply('saved: flash verified\r\n').ok);
for(const invalid of ['storage_api: 1\r\n',run.stdout.match(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/)[0].replace('schema: 2','schema: 3')]){if(invalid!==undefined)assert.throws(()=>parseStorage(invalid));}
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('# schema: 2','# schema: 3'),'dump'));
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('# config_end: 1','arm\r\n# config_end: 1'),'dump'));
assert.throws(()=>parseConfigurationExport(backups[3].raw.replace('mode_range HORIZON 1 6 1600 1900','mode_range HORIZON 1 257 1600 1900'),'dump'));
const actual=run.stdout.match(/storage_api: 1\r?\n[\s\S]*?storage_end: 1\r?\n/)[0];
const ready=parseStorage(actual.replace('backend: host_sim','backend: flash'));
assert(canSaveStorage(ready,true,false));for(const key of ['armed','benchActive','calibrationActive','flightEnabled'])assert(!canSaveStorage({...ready,[key]:true},true,false));assert(!canSaveStorage(ready,false,false));assert(!canSaveStorage(ready,true,true));
console.log('PASS real firmware → storage/export parsers: four modes, Horizon + manual/AUX selection, defaults/deltas, dirty/verified simulation distinction, unsafe save locks, legacy/truncated/invalid exports, no arm/save in backups');
