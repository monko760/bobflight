/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * D1 firmware -> Configurator contract on the real host firmware:
 * `storage` (now with accel_cal_saved) parses with the shipped parser exactly as
 * without the line, each `defaults_key: <key>=<value>` payload parses with the
 * real parseGetReply identically to the firmware's own `get <key>` reply, the
 * end count equals the key lines, and refusals are one exact line.
 */
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');const path=require('node:path');
const {parseStorage,parseGetReply}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const run=cmds=>{const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1<<20});assert.equal(r.status,0,r.stderr);return r.stdout;};
const GROUPS={pid:11,rates:9,filters:9};
const st=run(['storage']).match(/storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/)[0];
assert.match(st,/\r\nflight_enabled: [01]\r\naccel_cal_saved: (yes|no)\r\nstorage_end: 1\r\n$/);
assert.deepEqual(parseStorage(st),parseStorage(st.replace(/accel_cal_saved: (yes|no)\r\n/,'')));
for(const [g,count] of Object.entries(GROUPS)){
 const o=run(['set pid_roll_p 0.004','set rate_max_yaw 700','set gyro_lpf_hz 250',`defaults ${g}`]);
 const m=o.match(new RegExp(`defaults_group: ${g}\\r\\n((?:defaults_key: [^\\r\\n]+\\r\\n)*)defaults_end: ${g} (\\d+)\\r\\n`));assert(m,o);
 const keys=m[1].split('\r\n').filter(Boolean).map(l=>l.slice('defaults_key: '.length));
 assert.equal(keys.length,count);assert.equal(Number(m[2]),keys.length,'end count == key lines');
 const gets=run([`defaults ${g}`,...keys.map(k=>`get ${k.split('=')[0]}`)]).split('\r\n').filter(l=>/^[a-z0-9_]+=/.test(l));
 assert.deepEqual(keys,gets,'defaults_key payloads are byte-identical to get replies');
 for(let i=0;i<keys.length;i++){const a=parseGetReply(keys[i]+'\r\n'),b=parseGetReply(gets[i]+'\r\n');assert(a.ok&&a.key===b.key&&a.value===b.value,keys[i]);}
}
for(const [cmd,line] of [['defaults','defaults_error: group_required pid|rates|filters'],['defaults bogus','defaults_error: unknown_group']]){
 const o=run(['storage',cmd,'storage']);assert(o.includes(`\r\n${line}\r\n`),cmd);
 const s=[...o.matchAll(/storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/g)].map(x=>x[0]);assert.equal(s[0],s[1],`${cmd} changed storage`);
}
console.log('PASS real firmware defaults pid|rates|filters -> parseGetReply == get, end counts, exact refusals; storage with accel_cal_saved parses unchanged');
