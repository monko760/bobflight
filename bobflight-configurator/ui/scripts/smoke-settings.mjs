/**
 * Protocol-backed Rates/PID settings round-trip (MockTransportFactory).
 * Waits for connect banner before get/set — banner must not pollute collectors.
 */
import {
  BobFlightCliClient,
  MockTransportFactory,
  MOCK_PORT_PATH,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
} from "@bobflight/protocol";

const RATE_KEYS = [
  "rate_max_roll",
  "rate_max_pitch",
  "rate_max_yaw",
  "rate_expo",
];
const PID_KEYS = [
  "pid_roll_p",
  "pid_roll_i",
  "pid_roll_d",
  "pid_pitch_p",
  "pid_pitch_i",
  "pid_pitch_d",
  "pid_yaw_p",
  "pid_yaw_i",
];

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

function waitBanner(client, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error("banner timeout"));
    }, timeoutMs);
    const off = client.onLine((line) => {
      if (line.startsWith("BobFlight") && line.includes("ready")) {
        clearTimeout(t);
        off();
        resolve(line);
      }
    });
  });
}

const client = new BobFlightCliClient(new MockTransportFactory());

// Register BEFORE connect — banner is fire-and-forget from MockSerial.
const bannerPromise = waitBanner(client);
await client.connect({ path: MOCK_PORT_PATH, baudRate: 115200, transport: "mock" });
const banner = await bannerPromise;
assert(
  banner === "BobFlight 0.1.0-skeleton ready",
  "banner exact, got " + JSON.stringify(banner),
);

const all = await client.getAllSettings();
assert(Object.keys(all).length === 12, "expected 12 keys, got " + Object.keys(all).length);
for (const k of SETTINGS_KEYS) {
  assert(k in all, "missing " + k);
  assert(all[k] === DEFAULT_SETTINGS[k], "default " + k + "=" + all[k]);
}

// Rates round-trip
await client.setSetting("rate_max_roll", "750");
await client.setSetting("rate_expo", "0.45");
const rRoll = await client.getSetting("rate_max_roll");
const rExpo = await client.getSetting("rate_expo");
assert(rRoll.value === "750", "rate_max_roll got " + rRoll.value);
assert(rExpo.value === "0.45", "rate_expo got " + rExpo.value);

// PID round-trip
await client.setSetting("pid_roll_p", "0.003");
await client.setSetting("pid_yaw_i", "0.0025");
const pRoll = await client.getSetting("pid_roll_p");
const pYawI = await client.getSetting("pid_yaw_i");
assert(pRoll.value === "0.003", "pid_roll_p got " + pRoll.value);
assert(pYawI.value === "0.0025", "pid_yaw_i got " + pYawI.value);

await client.saveSettings();

const afterSaveRates = {};
for (const k of RATE_KEYS) {
  afterSaveRates[k] = (await client.getSetting(k)).value;
}
assert(afterSaveRates.rate_max_roll === "750", "saved rate");

const afterSavePid = {};
for (const k of PID_KEYS) {
  afterSavePid[k] = (await client.getSetting(k)).value;
}
assert(afterSavePid.pid_roll_p === "0.003", "saved pid");

const defs = await client.restoreDefaults();
assert(defs.rate_max_roll === DEFAULT_SETTINGS.rate_max_roll, "defaults rate");
assert(defs.pid_roll_p === DEFAULT_SETTINGS.pid_roll_p, "defaults pid");

await client.disconnect();
console.log("UI_PROTOCOL_SETTINGS_SMOKE_PASS", {
  banner,
  rate_max_roll: rRoll.value,
  rate_expo: rExpo.value,
  pid_roll_p: pRoll.value,
  pid_yaw_i: pYawI.value,
  defaults_rate: defs.rate_max_roll,
});
