/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real firmware `status` gyro sanity keys (Kakute + tmotor host builds) ->
 * Configurator gyroHealthView (Setup cards) and parseStatus (Arm gate).
 * Host build: proves the wire contract and key order only. The host has no gyro,
 * so it reports gyro_ok: no with gyro_health: ok and gyro_sat_count: 0; the
 * fault paths are covered by the firmware ctest `gyro_health`. */
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {gyroHealthView,parseStatus,GYRO_HEALTH_TOKENS}=require('../../bobflight-configurator/protocol/dist');
const binaries=[
 process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host'),
 process.argv[3]?path.resolve(process.argv[3]):path.resolve(__dirname,'../../bobflight-firmware/build-contract-tmotor/bobflight_host'),
];
for(const bin of binaries){
 assert.ok(fs.existsSync(bin),`host build missing: ${bin}`);
 const r=spawnSync(bin,[],{input:'status\n',encoding:'utf8',maxBuffer:1024*1024,timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);
 const lines=r.stdout.split(/\r?\n/);
 const at=k=>lines.findIndex(l=>l.startsWith(`${k}: `));
 const iOk=at('gyro_ok'),iH=at('gyro_health'),iS=at('gyro_sat_count');
 assert.ok(iOk>=0&&iH===iOk+1&&iS===iH+1,`gyro_ok, gyro_health, gyro_sat_count adjacent and in order: ${iOk} ${iH} ${iS}\n${r.stdout.slice(0,1500)}`);
 assert.ok(/^gyro_health: [a-z-]+\r?$/.test(lines[iH]),lines[iH]);
 assert.ok(/^gyro_sat_count: (0|[1-9][0-9]*)$/.test(lines[iS]),lines[iS]);
 const v=gyroHealthView(r.stdout);
 assert.equal(v.gyro_health,lines[iH].slice('gyro_health: '.length),'health shown verbatim');
 assert.ok(GYRO_HEALTH_TOKENS.includes(v.gyro_health),`FW token is one the docs list: ${v.gyro_health}`);
 assert.equal(v.gyro_sat_count,lines[iS].slice('gyro_sat_count: '.length),'sat count shown verbatim');
 assert.equal(v.olderFirmware,false);
 const st=parseStatus(r.stdout);
 if(v.gyro_health!=='ok') assert.equal(st.gyro_ok,'no','non-ok health must print gyro_ok no');
 console.log(`PASS ${path.basename(path.dirname(bin))}: ${lines[iOk]} / ${lines[iH]} / ${lines[iS]} -> Setup cards "${v.gyro_health}" / "${v.gyro_sat_count}"`);
}
/* FW token names (gyro_health_name) == the Configurator's documented list. */
const src=fs.readFileSync(path.resolve(__dirname,'../../bobflight-firmware/src/drivers/gyro.c'),'utf8');
for(const t of GYRO_HEALTH_TOKENS) assert.ok(src.includes(`"${t}"`),`gyro.c prints token ${t}`);
console.log('PASS firmware gyro_health tokens == GYRO_HEALTH_TOKENS');
