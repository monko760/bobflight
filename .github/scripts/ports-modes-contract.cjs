/* SPDX-License-Identifier: Apache-2.0
 * Cross-layer test: real host firmware snapshots through configurator parsers.
 * AUX indices are 1-based on wire; AUX1 maps rc[4], AUX12 maps rc[15]. */
const assert = require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {parsePorts,parseModes}=require('../../bobflight-configurator/protocol/dist');
const binary=process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname,'../../bobflight-firmware/build-contract/bobflight_host');
const invalid=[
 'mode_range ARM 1 aux1 1100 1450', 'mode_range ARM 1 0 1100 1450',
 'mode_range ARM 1 13 1100 1450', 'mode_range ARM 1 257 1100 1450',
 'mode_range ARM 1 -1 1100 1450', 'mode_range ARM 1 +1 1100 1450',
 'mode_range ARM 1 1.0 1100 1450', 'mode_range ARM 1 1 1100.5 1450',
 'mode_range ARM 1 1 66636 68000','mode_range ARM 1 4294967297 1100 1450',
 'mode_range ARM 1 1 899 1450','mode_range ARM 1 1 1100 2101',
 'mode_range ARM 1 1 1500 1500','mode_range ARM 2 1 1100 1450',
 'mode_range BEEPER 1 1 1100 1450','mode_range ARM 1 1 1100 1450 junk'
];
const commands=['ports','receiver_uart 1','ports','modes','mode_range ARM 1 12 1100 1450','modes','mode_range ANGLE 1 1 1200 1800','modes',...invalid.flatMap(x=>[x,'modes'])];
const run=spawnSync(binary,[],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:1024*1024});
assert.equal(run.status,0,run.stderr);
const ports=[...run.stdout.matchAll(/ports_api: 1\r?\n[\s\S]*?ports_end: 1\r?\n/g)].map(m=>parsePorts(m[0]));
const modes=[...run.stdout.matchAll(/modes_api: 1\r?\n[\s\S]*?modes_end: 1\r?\n/g)].map(m=>parseModes(m[0]));
assert.equal(ports.length,2);assert.equal(ports[0].receiverUart,6);assert.equal(ports[1].receiverUart,1);
assert.ok(ports[1].ports.some(p=>p.id===1&&p.role==='crsf'));assert.ok(ports[1].ports.some(p=>p.id===0&&p.role==='cli'&&!p.selectable));
assert.equal(modes.length,5+invalid.length,'initial + two apply/readback pairs + unchanged reads after invalid commands');
function row(s,name){return s.modes.find(m=>m.name===name);}
assert.equal(row(modes[0],'ARM').aux,1);assert.equal(row(modes[0],'ANGLE').aux,2);
for(const s of modes.slice(1)){assert.equal(row(s,'ARM').aux,12);assert.equal(row(s,'ARM').minUs,1100);assert.equal(row(s,'ARM').maxUs,1450);}
for(const s of modes.slice(3)){assert.equal(row(s,'ANGLE').aux,1);assert.equal(row(s,'ANGLE').minUs,1200);assert.equal(row(s,'ANGLE').maxUs,1800);}
assert.equal((run.stdout.match(/mode_range refused:/g)||[]).length,invalid.length);
for(const s of modes){assert.equal(s.semantics,"preview");assert.equal(s.flightEnabled,false);assert.equal(s.armed,false);assert.equal(s.rxFresh,false);assert.ok(s.modes.every(m=>!m.active));}
const reboot=spawnSync(binary,[],{input:'ports\nmodes\n',encoding:'utf8'});assert.equal(reboot.status,0);
const reset=parseModes(reboot.stdout.match(/modes_api: 1\r?\n[\s\S]*?modes_end: 1\r?\n/)[0]);assert.equal(row(reset,'ARM').aux,1);assert.equal(row(reset,'ANGLE').aux,2);
for(const p of run.stdout.matchAll(/(?:ports_api|modes_api): 1\r?\n[\s\S]*?(?:ports_end|modes_end): 1\r?\n/g))assert.ok(Buffer.byteLength(p[0])<2048,'snapshot fits CDC TX ring');
console.log(`PASS actual Kakute host firmware → configurator parsers: numeric AUX1/AUX12, UART selection, ${invalid.length} invalid commands rejected without mutation, freshness/bench lock, cold-start reset, bounded reports`);
