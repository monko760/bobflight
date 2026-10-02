/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Arm gate fail-closed on REAL firmware `status` output (safety S1 pairing).
 * Feeds status text captured from the real host firmware binary (committed in
 * fixtures/host-status-real.json, and, when a host binary is given or the CI
 * contract build exists, captured live) into the Configurator's own status
 * parser (ui/src/protocol/parseStatus.ts -> @bobflight/protocol parseStatus)
 * and asserts shouldDisableArm blocks Arm.
 * The host build has no receiver and no gyro, so its status always says
 * `gyro_ok: no` AND `failsafe: ACTIVE` (boot lockout until the first RX frame).
 * To check each cause on its own, exactly one line of the real capture is
 * switched to the other token the firmware prints (cli.c: gyro_ok yes|no,
 * failsafe ACTIVE|ok); the tokens are read from cli.c, not assumed. A control
 * with both switched must NOT block, proving these two lines are the gate.
 * mmio is display-only (PR #61 review): the dummy board's real capture says
 * `mmio: denied` (plus gyro_ok no + failsafe ACTIVE, so it blocks); with
 * both gating lines switched clear and `mmio: denied` left untouched, Arm
 * must NOT be blocked.
 * Usage: node ui/scripts/test-arm-gate-real-status.cjs [bobflight_host ...] */
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {loadUiTs}=require('../../protocol/tests/load-ui-ts.cjs');
const ui=loadUiTs(path.resolve(__dirname,'../src/protocol/parseStatus.ts'),{'@bobflight/protocol':require('../../protocol/dist')});
const fwRoot=path.resolve(__dirname,'../../../bobflight-firmware');
const cli=fs.readFileSync(path.join(fwRoot,'src/drivers/cli.c'),'utf8');
/* S3 (fix/gyro-sanity): the gyro_ok line moved into gyro.c gyro_status_lines(),
 * which prints gyro_ok, gyro_health, gyro_sat_count together; gyro_ok is yes
 * only for a valid gyro AND health ok, so every S3 fault reaches this gate as
 * gyro_ok: no. cli.c's status must print those lines (the fallback is "no"). */
const gyroC=fs.readFileSync(path.join(fwRoot,'src/drivers/gyro.c'),'utf8');
assert.ok(cli.includes('gyro_status_lines(gyro_lines, sizeof gyro_lines)')&&cli.includes('snprintf(gyro_lines, sizeof gyro_lines, "gyro_ok: no\\r\\n")'),'FW status prints gyro_status_lines (fallback gyro_ok: no)');
assert.ok(gyroC.includes('"gyro_ok: %s\\r\\ngyro_health: %s\\r\\ngyro_sat_count: %s\\r\\n"')&&gyroC.includes('ok ? "yes" : "no"')&&gyroC.includes('const bool ok = g_healthy && g_health == GYRO_HEALTH_OK;'),'FW gyro_ok tokens yes|no; yes needs a valid gyro and gyro_health ok');
assert.ok(cli.includes('"failsafe: %s\\r\\n"')&&cli.includes('failsafe_active() ? "ACTIVE" : "ok"'),'FW failsafe tokens ACTIVE|ok');
function swapLine(raw,key,from,to){
 const re=new RegExp(`^${key}: ${from}\\r$`,'m');assert.equal((raw.match(new RegExp(`^${key}: `,'gm'))||[]).length,1,`${key} once`);
 assert.match(raw,re,`${key}: ${from} in real capture`);return raw.replace(re,`${key}: ${to}\r`);
}
function check(label,raw){
 const real=ui.parseStatus(raw);
 assert.equal(real.gyro_ok,'no');assert.equal(real.failsafe,'ACTIVE');
 assert.equal(ui.shouldDisableArm(real),true,`${label}: real capture blocks Arm`);
 assert.ok(real.failClosed&&real.failClosedReasons.includes('gyro_ok:no')&&real.failClosedReasons.includes('failsafe:ACTIVE'),`${label}: both reasons`);
 const fsOnly=ui.parseStatus(swapLine(raw,'gyro_ok','no','yes'));     // failsafe active, gyro healthy
 assert.equal(fsOnly.failsafe,'ACTIVE');assert.equal(fsOnly.gyro_ok,'yes');
 assert.equal(ui.shouldDisableArm(fsOnly),true,`${label}: failsafe ACTIVE alone blocks Arm`);
 assert.ok(fsOnly.failClosedReasons.includes('failsafe:ACTIVE')&&!fsOnly.failClosedReasons.includes('gyro_ok:no'));
 const gyroOnly=ui.parseStatus(swapLine(raw,'failsafe','ACTIVE','ok'));  // gyro unhealthy, failsafe clear
 assert.equal(gyroOnly.gyro_ok,'no');assert.equal(gyroOnly.failsafe,'ok');
 assert.equal(ui.shouldDisableArm(gyroOnly),true,`${label}: gyro_ok no alone blocks Arm`);
 assert.ok(gyroOnly.failClosedReasons.includes('gyro_ok:no')&&!gyroOnly.failClosedReasons.includes('failsafe:ACTIVE'));
 const clear=ui.parseStatus(swapLine(swapLine(raw,'gyro_ok','no','yes'),'failsafe','ACTIVE','ok'));
 assert.equal(ui.shouldDisableArm(clear),false,`${label}: control (both clear) does not block`);
 assert.equal(ui.shouldDisableArm(null),true,'no status = blocked');
 console.log(`PASS ${label}: real FW status -> Configurator parser: Arm blocked on failsafe ACTIVE, on gyro_ok no, and on both; open only when both clear`);
}
/* mmio is never an Arm gate: with gyro_ok yes + failsafe ok the Arm button
 * opens whatever the mmio line says (here the real dummy `mmio: denied`). */
function checkMmioDisplayOnly(label,raw){
 const real=ui.parseStatus(raw);
 assert.equal(real.mmio,'denied',`${label}: real capture says mmio: denied`);
 assert.equal(ui.shouldDisableArm(real),true,`${label}: real capture (gyro_ok no, failsafe ACTIVE) blocks`);
 const clear=ui.parseStatus(swapLine(swapLine(raw,'gyro_ok','no','yes'),'failsafe','ACTIVE','ok'));
 assert.equal(clear.mmio,'denied');assert.equal(clear.gyro_ok,'yes');assert.equal(clear.failsafe,'ok');
 assert.equal(ui.shouldDisableArm(clear),false,`${label}: mmio: denied with both gating lines clear must NOT block Arm`);
 assert.ok(!clear.failClosedReasons.some(r=>/mmio/i.test(r)),`${label}: mmio is not a fail-closed reason`);
 console.log(`PASS ${label}: mmio: denied is display-only (Arm open when gyro_ok yes + failsafe ok)`);
}
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/host-status-real.json'),'utf8'));
assert.deepEqual(Object.keys(fixtures).sort(),['dummy','kakute_f7_hdv','tmotor_f7_v2']);
for(const [board,f] of Object.entries(fixtures))check(`fixture ${board}`,f.raw);
checkMmioDisplayOnly('fixture dummy',fixtures.dummy.raw);
const bins=process.argv.slice(2);
for(const d of ['build-contract','build-contract-tmotor','build-contract-dummy']){const p=path.join(fwRoot,d,'bobflight_host');if(!bins.length&&fs.existsSync(p))bins.push(p);}
for(const bin of bins){
 const r=spawnSync(bin,[],{input:'status\n',encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);
 const o=r.stdout;const raw=o.slice(o.indexOf('board: '),o.indexOf('\r\n',o.indexOf('motor_output: '))+2);
 check(`live ${path.relative(fwRoot,bin)}`,raw);
 if(/^mmio: denied\r$/m.test(raw))checkMmioDisplayOnly(`live ${path.relative(fwRoot,bin)}`,raw);
}
if(!bins.length)console.log('NOTE no host binary given or built; live capture skipped (fixtures only)');
