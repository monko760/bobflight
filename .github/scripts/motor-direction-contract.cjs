/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware motor_direction CLI (host build, schema 10) -> Configurator
 * motor-direction parsers/view and mock/FW reply parity. Proves the wire
 * contract, the `mixer` report shape and signs (== mock), the refusal lines
 * kept verbatim with the value unchanged, diff/dump parsed by the export
 * parser under 3072 B, defaults -> props-out, and save + reboot keeping
 * props-in. The host cannot arm (no gyro) or run a motor test (no DShot), so
 * those two lines are checked against the FW header source (and the C test
 * motor_direction_cli_unit exercises them on the real code).
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseMotorDirectionGetReply,parseMotorDirectionSetReply,parseMixerReport,motorDirectionView,MockMotorDirection,
  MOTOR_DIRECTION_ARMED_LINE,MOTOR_DIRECTION_MOTOR_TEST_LINE,MOTOR_DIRECTION_INVALID_LINE,parseStorage,parseConfigurationExport,STORAGE_SCOPE_V13,CONFIG_EXPORT_MAX_BYTES}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const PAD=' '.repeat(64);
function run(cmds,reinit=false){
 const env={...process.env};if(reinit)env.BOBFLIGHT_HOST_REBOOT_REINIT='1';
 const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',env,maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;
}
const reports=o=>[...o.matchAll(/mixer_api: 1\r?\n[\s\S]*?mixer_end: 1\r?\n/g)].map(m=>m[0]);
const gets=o=>[...o.matchAll(/^motor_direction=.*$/gm)].map(m=>m[0].replace(/\r$/,'')+'\r\n');
const line=(o,re)=>{const m=o.match(re);assert.ok(m,String(re));return m[0].replace(/\r$/,'');};
const storage=o=>parseStorage(o.slice(o.lastIndexOf('storage_api: 1'),o.lastIndexOf('storage_end: 1')+'storage_end: 1'.length));
const norm=s=>s.replace(/\r/g,'');

// 0. The refusal lines the Configurator knows are the FW header's, byte for byte.
{
 const h=fs.readFileSync(path.resolve(__dirname,'../../bobflight-firmware/src/drivers/motor_direction_cli.h'),'utf8');
 for(const [name,want] of [['MOTOR_DIRECTION_ARMED_LINE',MOTOR_DIRECTION_ARMED_LINE],['MOTOR_DIRECTION_MOTOR_TEST_LINE',MOTOR_DIRECTION_MOTOR_TEST_LINE],['MOTOR_DIRECTION_INVALID_LINE',MOTOR_DIRECTION_INVALID_LINE]]){
  const m=new RegExp(`#define ${name} "([^"]*)"`).exec(h);assert.ok(m,name);assert.equal(m[1],want,name);
 }
}
// 1. Defaults: props-out, report == mock, view, storage schema 13.
{
 const o=run(['get motor_direction','mixer','storage']);
 assert.deepEqual(gets(o),[new MockMotorDirection('props-out').handle('get motor_direction',false)]);
 assert.deepEqual(parseMotorDirectionGetReply(gets(o)[0]),{kind:'value',token:'props-out'});
 assert.equal(norm(reports(o)[0]),norm(new MockMotorDirection('props-out').report()),'FW props-out report == mock');
 const v=motorDirectionView(parseMotorDirectionGetReply(gets(o)[0]),parseMixerReport(reports(o)[0]));
 assert.deepEqual([v.held,v.selected,v.mixerDirection,v.yaw.join(' ')],['props-out','props-out','props-out','-1 +1 +1 -1']);
 const st=storage(o);assert.equal(st.schema,13);assert.equal(st.scope,STORAGE_SCOPE_V13);
}
// 2. set -> get -> mixer (the Configurator order); refusals verbatim, value unchanged; replies == mock.
{
 const cmds=['set motor_direction props-in','get motor_direction','mixer','set motor_direction sideways','get motor_direction','set motor_direction props-out','get motor_direction','mixer'];
 const o=run(cmds);
 const mock=new MockMotorDirection('props-out');const want=cmds.map(c=>mock.handle(c,false)).join('');
 assert.equal(norm(o.slice(o.indexOf('ok motor_direction=props-in'),o.lastIndexOf('mixer_end: 1')+'mixer_end: 1\r\n'.length)),norm(want),'FW replies == mock replies, in order');
 assert.deepEqual(parseMotorDirectionSetReply(line(o,/^ok motor_direction=props-in\r?$/m),'props-in'),{ok:true,token:'props-in'});
 assert.deepEqual(parseMotorDirectionSetReply(line(o,/^set failed: motor_direction.*$/m),'props-in'),{ok:false,unsupported:false,line:MOTOR_DIRECTION_INVALID_LINE});
 assert.deepEqual(gets(o).map(g=>parseMotorDirectionGetReply(g).token),['props-in','props-in','props-out'],'refused set leaves props-in');
 assert.deepEqual(reports(o).map(r=>parseMixerReport(r).yaw.join(' ')),['+1 -1 -1 +1','-1 +1 +1 -1']);
}
// 3. diff/dump through the export parser (< 2560 B); defaults -> props-out.
{
 const o=run(['set motor_direction props-in','diff all','dump all','defaults','get motor_direction','diff all']);
 const ex=[...o.matchAll(/# bobflight_config: 1\r?\n[\s\S]*?# config_end: 1\r?\n/g)].map(m=>m[0]);assert.equal(ex.length,3);
 for(const [i,kind] of [[0,'diff'],[1,'dump'],[2,'diff']]){const e=parseConfigurationExport(ex[i],kind);assert(Buffer.byteLength(e.raw)<CONFIG_EXPORT_MAX_BYTES);}
 assert.match(ex[0],/\r\nset motor_direction props-in\r\n/);assert.match(ex[1],/\r\nset motor_poles 14\r\nset align_board_roll 0\r\nset align_board_pitch 0\r\nset align_board_yaw 0\r\n(?:set rate_(?:center|expo)_(?:roll|pitch|yaw) [^\r\n]+\r\n){6}set motor_direction props-in\r\n/);assert(!/motor_direction props/.test(ex[2]),'diff after defaults omits it');
 assert.equal(gets(o).at(-1),'motor_direction=props-out\r\n');
}
// 4. Save + reboot keeps props-in, storage clean, the mixer applies it after boot.
{
 const o=run(['set motor_direction props-in','save','reboot',PAD,'get motor_direction','mixer','storage'],true);
 assert.equal(gets(o).at(-1),'motor_direction=props-in\r\n');
 assert.equal(norm(reports(o).at(-1)),norm(new MockMotorDirection('props-in').report()));
 const st=storage(o);assert.equal(st.dirty,false);assert.equal(st.schema,13);
}
console.log('PASS firmware motor_direction CLI -> Configurator parsers/view: default props-out, mixer report == mock (signs -1 +1 +1 -1 / +1 -1 -1 +1), set -> get -> mixer replies == mock, refusal lines == FW header and verbatim with the value unchanged, diff/dump parsed under 3072 B, defaults -> props-out, save + reboot keeps props-in. Host build.');
