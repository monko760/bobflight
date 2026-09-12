import {
  BobFlightCliClient,
  MOCK_PORT_PATH,
  MockTransportFactory,
} from "@bobflight/protocol";

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

const c = new BobFlightCliClient(new MockTransportFactory());
const bannerPromise = waitBanner(c);
await c.connect({ path: MOCK_PORT_PATH, baudRate: 115200, transport: "mock" });
await bannerPromise;
const all = await c.getAllSettings();
if (Object.keys(all).length !== 12) throw new Error("expected 12 keys, got " + Object.keys(all).length);
await c.setSetting("rate_max_roll", "720");
await c.setSetting("pid_roll_p", "0.003");
await c.saveSettings();
const r = await c.getSetting("rate_max_roll");
const p = await c.getSetting("pid_roll_p");
if (r.value !== "720") throw new Error("rate set failed: " + r.value);
if (p.value !== "0.003") throw new Error("pid set failed: " + p.value);
const defs = await c.restoreDefaults();
if (defs.rate_max_roll === undefined) throw new Error("defaults missing");
await c.disconnect();
console.log("PROTOCOL SETTINGS MOCK PASS", {
  rate: r.value,
  pid: p.value,
  defaults_rate: defs.rate_max_roll,
});
