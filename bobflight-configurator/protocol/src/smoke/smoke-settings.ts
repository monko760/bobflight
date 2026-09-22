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

  // Canonical %.6g defaults (document / sanity)
  console.log("formatFwFloat defaults:");
  for (const [k, v] of Object.entries({
    rate_max: 800,
    rate_expo: 0.3,
    pid_p: 0.002,
    pid_i: 0.001,
    pid_d: 0.00005,
  })) {
    console.log(`  ${k}: ${v} → ${formatFwFloat(v)}`);
  }
  assert(formatFwFloat(800) === "800", "formatFwFloat 800");
  assert(formatFwFloat(0.3) === "0.3", "formatFwFloat 0.3");
  assert(formatFwFloat(0.002) === "0.002", "formatFwFloat 0.002");
  assert(formatFwFloat(0.001) === "0.001", "formatFwFloat 0.001");
  assert(formatFwFloat(0.00005) === "5e-05", "formatFwFloat 5e-05");
  assert(DEFAULT_SETTINGS.rate_expo === "0.3", "DEFAULT rate_expo");
  assert(DEFAULT_SETTINGS.pid_roll_d === "5e-05", "DEFAULT pid_roll_d");

  const factory = new MockTransportFactory();
  const client = new BobFlightCliClient(factory);

  await client.connect({ path: MOCK_PORT_PATH, baudRate: 115200 });
  assert(client.getConnectionStatus() === "connected", "connected");

  // Give banner idle time so it does not collide with first get collector.
  await new Promise((r) => setTimeout(r, 60));

  // --- get all 12 ---
  const all = await client.getAllSettings();
  console.log("getAllSettings keys:", Object.keys(all).length);
  assert(Object.keys(all).length === SETTINGS_KEYS.length, `${SETTINGS_KEYS.length} keys`);
  for (const key of SETTINGS_KEYS) {
    assert(all[key] === DEFAULT_SETTINGS[key], `default ${key}=${all[key]}`);
    console.log(`  ${key}=${all[key]}`);
  }

  // Parser unit checks (exact no-space shapes; tolerant of any value token)
  const g = parseGetReply("pid_roll_p=0.002\r\n");
  assert(g.ok && g.key === "pid_roll_p" && g.value === "0.002", "parseGetReply");
  const gSci = parseGetReply("pid_roll_d=5e-05\r\n");
  assert(gSci.ok && gSci.value === "5e-05", "parseGetReply sci");
  const gu = parseGetReply("unknown key\r\n");
  assert(gu.unknown === true && !gu.ok, "parseGetReply unknown");
  const s = parseSetReply("ok pid_roll_p=0.005\r\n");
  assert(s.ok && s.key === "pid_roll_p" && s.value === "0.005", "parseSetReply");
  const su = parseSetReply("unknown key\r\n");
  assert(su.unknown === true && !su.ok, "parseSetReply unknown");
  const sf = parseSetReply("set failed\r\n");
  assert(sf.failed === true && !sf.ok, "parseSetReply failed");
  assert(parseSaveReply("saved: flash verified\r\n").ok, "parseSaveReply");
  assert(!parseSaveReply("save failed\r\n").ok, "parseSaveReply fail");
  assert(parseDefaultsReply("defaults restored\r\n").ok, "parseDefaultsReply");

  // --- set one, get reflects (%.6g emit) ---
  const setRes = await client.setSetting("pid_roll_p", "0.005");
  assert(setRes.key === "pid_roll_p" && setRes.value === "0.005", "setSetting");
  console.log("setSetting:", setRes);

  const got = await client.getSetting("pid_roll_p");
  assert(got.value === "0.005", `get after set, got ${got.value}`);
  console.log("get after set:", got);

  // --- set failed: non-numeric ---
  const badNum = await client.sendRaw("set pid_roll_p not_a_number");
  assert(
    badNum.trim() === "set failed",
    `bad number: ${JSON.stringify(badNum)}`
  );
  console.log("set failed (non-numeric): ok");

  // --- set failed: out of range ---
  const badRangePid = await client.sendRaw("set pid_roll_p 11");
  assert(
    badRangePid.trim() === "set failed",
    `pid OOR: ${JSON.stringify(badRangePid)}`
  );
  const badRangeRate = await client.sendRaw("set rate_max_roll 5");
  assert(
    badRangeRate.trim() === "set failed",
    `rate_max OOR: ${JSON.stringify(badRangeRate)}`
  );
  const badExpo = await client.sendRaw("set rate_expo 1.5");
  assert(
    badExpo.trim() === "set failed",
    `expo OOR: ${JSON.stringify(badExpo)}`
  );
  console.log("set failed (out of range): ok");

  // Value unchanged after failed sets
  const still = await client.getSetting("pid_roll_p");
  assert(still.value === "0.005", `unchanged after fail, got ${still.value}`);

  // --- save acks ---
  await client.saveSettings().then(() => { throw new Error("Mock must not claim flash persistence"); }, () => {});
  console.log("saveSettings: mock correctly refuses durable controller save");

  // --- defaults restores (does not auto-save; values reset in RAM) ---
  const afterDefaults = await client.restoreDefaults();
  assert(
    afterDefaults.pid_roll_p === DEFAULT_SETTINGS.pid_roll_p,
    `defaults restore pid_roll_p=${afterDefaults.pid_roll_p}`
  );
  assert(
    afterDefaults.rate_expo === DEFAULT_SETTINGS.rate_expo,
    "defaults rate_expo"
  );
  assert(
    afterDefaults.pid_roll_d === DEFAULT_SETTINGS.pid_roll_d,
    `defaults pid_roll_d=${afterDefaults.pid_roll_d}`
  );
  console.log("restoreDefaults: pid_roll_p back to", afterDefaults.pid_roll_p);

  // Unknown key path via sendRaw
  const unk = await client.sendRaw("get not_a_real_key");
  assert(unk.trim() === "unknown key", `unknown get: ${JSON.stringify(unk)}`);
  console.log("unknown key get: ok");

  await client.disconnect();
  console.log("=== SMOKE:SETTINGS PASS ===");
}

main().catch((err) => {
  console.error("=== SMOKE:SETTINGS FAIL ===");
  console.error(err);
  process.exit(1);
});
