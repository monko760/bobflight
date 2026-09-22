/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Smoke: settings get/set/save/defaults against MockSerial (exact FW reply shapes).
 */

import {
  BobFlightCliClient,
  MockTransportFactory,
  MOCK_PORT_PATH,
  SETTINGS_KEYS,
  SCHEMA5_FLOAT_KEYS,
  SCHEMA6_FLOAT_KEYS,
  DEFAULT_SETTINGS,
  formatFwFloat,
  parseGetReply,
  parseSetReply,
  parseSaveReply,
  parseDefaultsReply,
} from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main(): Promise<void> {
  console.log("=== BobFlight protocol smoke:settings (MockSerial) ===");
  console.log("formatFwFloat defaults:");
  for (const [k, v] of Object.entries({rate_max:800,rate_expo:0.3,pid_p:0.002,pid_i:0.001,pid_d:0.00005})) console.log(`  ${k}: ${v} → ${formatFwFloat(v)}`);
  assert(formatFwFloat(800) === "800", "formatFwFloat 800"); assert(formatFwFloat(0.3) === "0.3", "formatFwFloat 0.3"); assert(formatFwFloat(0.002) === "0.002", "formatFwFloat 0.002"); assert(formatFwFloat(0.001) === "0.001", "formatFwFloat 0.001"); assert(formatFwFloat(0.00005) === "5e-05", "formatFwFloat 5e-05");
  assert(DEFAULT_SETTINGS.rate_expo === "0.3", "DEFAULT rate_expo"); assert(DEFAULT_SETTINGS.pid_roll_d === "5e-05", "DEFAULT pid_roll_d");
  const factory = new MockTransportFactory(); const client = new BobFlightCliClient(factory);
  await client.connect({ path: MOCK_PORT_PATH, baudRate: 115200 }); assert(client.getConnectionStatus() === "connected", "connected");
  await new Promise((r) => setTimeout(r, 60));
  const all = await client.getAllSettings(); console.log("getAllSettings keys:", Object.keys(all).length); assert(Object.keys(all).length === SETTINGS_KEYS.length, `${SETTINGS_KEYS.length} keys`);
  assert(SCHEMA5_FLOAT_KEYS[0] === "gyro_lpf_hz" && SCHEMA5_FLOAT_KEYS[1] === "dterm_lpf_hz", "SCHEMA5_FLOAT_KEYS"); assert(SETTINGS_KEYS.includes("gyro_lpf_hz"), "SETTINGS_KEYS has gyro_lpf_hz"); assert(SETTINGS_KEYS.includes("dterm_lpf_hz"), "SETTINGS_KEYS has dterm_lpf_hz");
  for (const key of SETTINGS_KEYS) { assert(all[key] === DEFAULT_SETTINGS[key], `default ${key}=${all[key]}`); console.log(`  ${key}=${all[key]}`); }
  const g = parseGetReply("pid_roll_p=0.002\r\n"); assert(g.ok && g.key === "pid_roll_p" && g.value === "0.002", "parseGetReply"); const gSci = parseGetReply("pid_roll_d=5e-05\r\n"); assert(gSci.ok && gSci.value === "5e-05", "parseGetReply sci"); const gu = parseGetReply("unknown key\r\n"); assert(gu.unknown === true && !gu.ok, "parseGetReply unknown");
  const s = parseSetReply("ok pid_roll_p=0.005\r\n"); assert(s.ok && s.key === "pid_roll_p" && s.value === "0.005", "parseSetReply"); const su = parseSetReply("unknown key\r\n"); assert(su.unknown === true && !su.ok, "parseSetReply unknown"); const sf = parseSetReply("set failed\r\n"); assert(sf.failed === true && !sf.ok, "parseSetReply failed"); assert(parseSaveReply("saved: flash verified\r\n").ok, "parseSaveReply"); assert(!parseSaveReply("save failed\r\n").ok, "parseSaveReply fail"); assert(parseDefaultsReply("defaults restored\r\n").ok, "parseDefaultsReply");
  const setRes = await client.setSetting("pid_roll_p", "0.005"); assert(setRes.key === "pid_roll_p" && setRes.value === "0.005", "setSetting"); const got = await client.getSetting("pid_roll_p"); assert(got.value === "0.005", `get after set, got ${got.value}`);
  const badNum = await client.sendRaw("set pid_roll_p not_a_number"); assert(badNum.trim() === "set failed", `bad number: ${JSON.stringify(badNum)}`); const badRangePid = await client.sendRaw("set pid_roll_p 11"); assert(badRangePid.trim() === "set failed", `pid OOR: ${JSON.stringify(badRangePid)}`); const badRangeRate = await client.sendRaw("set rate_max_roll 5"); assert(badRangeRate.trim() === "set failed", `rate_max OOR: ${JSON.stringify(badRangeRate)}`); const badExpo = await client.sendRaw("set rate_expo 1.5"); assert(badExpo.trim() === "set failed", `expo OOR: ${JSON.stringify(badExpo)}`); const still = await client.getSetting("pid_roll_p"); assert(still.value === "0.005", `unchanged after fail, got ${still.value}`);
  assert(all.gyro_lpf_hz === "320", `default gyro_lpf_hz=${all.gyro_lpf_hz}`); assert(all.dterm_lpf_hz === "53", `default dterm_lpf_hz=${all.dterm_lpf_hz}`); const gLpf = parseGetReply("gyro_lpf_hz=320\r\n"); assert(gLpf.ok && gLpf.key === "gyro_lpf_hz" && gLpf.value === "320", "parseGet LPF"); const sLpf = parseSetReply("ok dterm_lpf_hz=53\r\n"); assert(sLpf.ok && sLpf.key === "dterm_lpf_hz" && sLpf.value === "53", "parseSet LPF"); const setLpf = await client.setSetting("gyro_lpf_hz", "250"); assert(setLpf.value === "250", `set gyro_lpf_hz got ${setLpf.value}`); const getLpf = await client.getSetting("gyro_lpf_hz"); assert(getLpf.value === "250", `get gyro_lpf_hz got ${getLpf.value}`); const setOff = await client.setSetting("dterm_lpf_hz", "0"); assert(setOff.value === "0", "dterm_lpf_hz 0=off"); const lpfOorHi = await client.sendRaw("set gyro_lpf_hz 1001"); assert(lpfOorHi.trim() === "set failed", `LPF hi OOR: ${JSON.stringify(lpfOorHi)}`); const lpfOorLo = await client.sendRaw("set gyro_lpf_hz 9"); assert(lpfOorLo.trim() === "set failed", `LPF lo OOR (9): ${JSON.stringify(lpfOorLo)}`); const lpfFive = await client.sendRaw("set gyro_lpf_hz 5"); assert(lpfFive.trim() === "set failed", `LPF set 5 must fail: ${JSON.stringify(lpfFive)}`); const lpfNeg = await client.sendRaw("set dterm_lpf_hz -1"); assert(lpfNeg.trim() === "set failed", `LPF neg: ${JSON.stringify(lpfNeg)}`); const lpfOk10 = await client.setSetting("dterm_lpf_hz", "10"); assert(lpfOk10.value === "10", "dterm_lpf_hz 10 edge ok");
  assert(SETTINGS_KEYS.includes("pid_yaw_d"), "SETTINGS_KEYS has pid_yaw_d"); assert(SCHEMA6_FLOAT_KEYS[0] === "pid_yaw_d", "SCHEMA6_FLOAT_KEYS[0]"); const yawD = await client.getSetting("pid_yaw_d"); assert(yawD.value === "5e-05", `default pid_yaw_d=${yawD.value}`); const setYawOk = await client.setSetting("pid_yaw_d", "0.0001"); assert(setYawOk.value === "0.0001", `set pid_yaw_d in-range got ${setYawOk.value}`); const yawOor = await client.sendRaw("set pid_yaw_d 11"); assert(yawOor.trim() === "set failed", `pid_yaw_d OOR: ${JSON.stringify(yawOor)}`); const yawNan = await client.sendRaw("set pid_yaw_d nan"); assert(yawNan.trim() === "set failed", `pid_yaw_d non-finite: ${JSON.stringify(yawNan)}`); const yawInf = await client.sendRaw("set pid_yaw_d Infinity"); assert(yawInf.trim() === "set failed", `pid_yaw_d Inf: ${JSON.stringify(yawInf)}`);
  await client.saveSettings().then(() => { throw new Error("Mock must not claim flash persistence"); }, () => {}); const afterDefaults = await client.restoreDefaults(); assert(afterDefaults.pid_roll_p === DEFAULT_SETTINGS.pid_roll_p, `defaults restore pid_roll_p=${afterDefaults.pid_roll_p}`); assert(afterDefaults.rate_expo === DEFAULT_SETTINGS.rate_expo, "defaults rate_expo"); assert(afterDefaults.pid_roll_d === DEFAULT_SETTINGS.pid_roll_d, `defaults pid_roll_d=${afterDefaults.pid_roll_d}`); assert(afterDefaults.gyro_lpf_hz === DEFAULT_SETTINGS.gyro_lpf_hz, `defaults gyro_lpf_hz=${afterDefaults.gyro_lpf_hz}`); assert(afterDefaults.dterm_lpf_hz === DEFAULT_SETTINGS.dterm_lpf_hz, `defaults dterm_lpf_hz=${afterDefaults.dterm_lpf_hz}`); assert(afterDefaults.pid_yaw_d === DEFAULT_SETTINGS.pid_yaw_d, `defaults pid_yaw_d=${afterDefaults.pid_yaw_d}`); const unk = await client.sendRaw("get not_a_real_key"); assert(unk.trim() === "unknown key", `unknown get: ${JSON.stringify(unk)}`); await client.disconnect(); console.log("=== SMOKE:SETTINGS PASS ===");
}
main().catch((err) => { console.error("=== SMOKE:SETTINGS FAIL ==="); console.error(err); process.exit(1); });
