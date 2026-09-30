/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Filters tab gyro notch rows: controller over the UI mock host (5 scenarios), refused set, reload guard and FiltersPage wiring. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { parseCliInput } from "../src/protocol/types";
import { GYRO_NOTCH_MOCK_SCENARIOS, type GyroNotchMockScenario } from "../../protocol/src/gyro-notch-mock";
import { STORAGE_SCOPE_V7, STORAGE_SCOPE_V8 } from "../../protocol/src/storage";
import { REFRESH_CONFIRM_MESSAGE, requestRefresh } from "../src/components/storageRefresh";
import {
  applyNotch, draftDirty, draftFromRow, draftPair, draftProblem, loadedPair, notchesSupported, notchRows, readNotches, requestFiltersReload,
  DISCARD_EDITS_MESSAGE, type NotchHost,
} from "../src/filters/gyroNotch";
import type { SettingsKey } from "../src/protocol";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** Source without comments, so doc text cannot satisfy or trip a wiring check. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

async function mockHost(scenario: GyroNotchMockScenario) {
  const host = new MockBobFlightHost({ connectDelayMs: 0, gyroNotchScenario: scenario });
  await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  return host;
}
const storageReply = (schema: string, dirty = "0") => ["storage_api: 1", "backend: flash", `schema: ${schema}`, `state: ${dirty === "1" ? "dirty" : "saved"}`, `dirty: ${dirty}`, "generation: 2",
  "last_error: none", `scope: ${schema === "8" ? STORAGE_SCOPE_V8 : STORAGE_SCOPE_V7}`, "armed: 0", "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", "storage_end: 1"].join("\r\n");
const report = (r1: string, a1 = "no") => `filters_api: 1\r\nfilters_sample_hz: 4000\r\ngyro_notch1_active: ${a1}\r\ngyro_notch1_reason: ${r1}\r\ngyro_notch2_active: no\r\ngyro_notch2_reason: off\r\nfilters_end: 1\r\n`;
/** Scripted FC: values map, custom `filters`/`storage` replies, records every line. */
function fakeHost(values: Partial<Record<string, string>>, opts: { filters?: string; storage?: string; setReply?: (k: string, v: string) => string | null } = {}) {
  const sent: string[] = [];
  const host: NotchHost = {
    async getSetting(key) { sent.push(`get ${key}`); const v = values[key]; if (v === undefined) throw new Error(`get ${key} failed: "unknown key"`); return { key, value: v }; },
    async setSetting(key, value) { sent.push(`set ${key} ${value}`); const r = opts.setReply?.(key, value) ?? null; if (r !== null) throw new Error(r); return { key, value }; },
    async sendCommand(cmd) { sent.push(cmd); if (cmd === "filters") return opts.filters ?? "unknown — try help\r\n"; if (cmd === "storage") return opts.storage ?? "unknown — try help\r\n"; return ""; },
  };
  return { host, sent };
}

async function main() {
  await test("five mock scenarios: rows, active and reason verbatim from the FC", async () => {
    assert.deepEqual([...GYRO_NOTCH_MOCK_SCENARIOS], ["off", "ok", "above-nyquist", "invalid", "old-fc"]);
    const expected: Record<GyroNotchMockScenario, [string, string, string, string]> = {
      off: ["0", "0", "no", "off"], ok: ["200", "150", "yes", "ok"], "above-nyquist": ["600", "420", "no", "above-nyquist"], invalid: ["200", "150", "no", "invalid"],
      "old-fc": ["unknown", "unknown", "unknown", "unknown"],
    };
    for (const s of GYRO_NOTCH_MOCK_SCENARIOS) {
      const host = await mockHost(s);
      const snap = await readNotches(host);
      const [r1, r2] = notchRows(snap);
      assert.deepEqual([r1.center, r1.cutoff, r1.active, r1.reason], expected[s], s);
      assert.equal(notchesSupported(snap), s !== "old-fc", s);
      if (s !== "old-fc") assert.deepEqual([r2.center, r2.active, r2.reason], ["0", "no", "off"], s);
      await host.disconnect();
    }
  });

  await test("older FC (keys missing or schema < 8): disabled rows, unknown — never 0 or off", async () => {
    const host = await mockHost("old-fc");
    const all = await host.getAllSettings();
    assert.equal((all as Record<string, string | undefined>).gyro_notch1_hz, undefined, "missing, not 0");
    for (const r of notchRows(await readNotches(host))) {
      assert.equal(r.supported, false); assert.equal(r.cutoffDisabled, true); assert.equal(r.off, null);
      for (const v of [r.center, r.cutoff, r.active, r.reason]) { assert.equal(v, "unknown"); assert.notEqual(v, "0"); assert.notEqual(v, "off"); }
      assert.deepEqual(draftFromRow(r), { enabled: false, center: "", cutoff: "" });
      assert.equal(draftDirty(r, { enabled: true, center: "200", cutoff: "150" }), false, "old FC rows cannot be edited");
    }
    await host.disconnect();
    // Keys answer but storage says schema 7: still unsupported.
    const v = { gyro_notch1_hz: "0", gyro_notch1_cutoff_hz: "0", gyro_notch2_hz: "0", gyro_notch2_cutoff_hz: "0" };
    const s7 = await readNotches(fakeHost(v, { filters: report("off"), storage: storageReply("7") }).host);
    assert.equal(s7.schema, 7); assert.equal(notchesSupported(s7), false);
    assert.ok(notchRows(s7).every((r) => r.center === "unknown" && r.reason === "unknown"));
    const s8 = await readNotches(fakeHost(v, { filters: report("off"), storage: storageReply("8") }).host);
    assert.equal(s8.schema, 8); assert.equal(notchesSupported(s8), true);
    // One key missing: unknown.
    const partial = await readNotches(fakeHost({ ...v, gyro_notch2_cutoff_hz: undefined }, { filters: report("off") }).host);
    assert.equal(notchesSupported(partial), false);
  });

  await test("unknown reason/active tokens are shown as sent, never mapped to ok", async () => {
    const v = { gyro_notch1_hz: "200", gyro_notch1_cutoff_hz: "150", gyro_notch2_hz: "0", gyro_notch2_cutoff_hz: "0" };
    const [r1] = notchRows(await readNotches(fakeHost(v, { filters: report("guard-fallback", "maybe") }).host));
    assert.equal(r1.reason, "guard-fallback"); assert.equal(r1.active, "maybe");
    const [n1] = notchRows(await readNotches(fakeHost(v, { filters: "garbage\r\n" }).host));
    assert.equal(n1.reason, "unknown"); assert.equal(n1.active, "unknown"); assert.equal(n1.center, "200");
  });

  await test("centre 0: cutoff input disabled but keeps its stored value (never cleared)", async () => {
    const v = { gyro_notch1_hz: "0", gyro_notch1_cutoff_hz: "150", gyro_notch2_hz: "0", gyro_notch2_cutoff_hz: "0" };
    const [r1] = notchRows(await readNotches(fakeHost(v, { filters: report("off") }).host));
    assert.equal(r1.cutoffDisabled, true); assert.equal(r1.cutoff, "150");
    const d = draftFromRow(r1);
    assert.deepEqual(d, { enabled: false, center: "", cutoff: "150" });
    assert.deepEqual(draftPair(d), { center: 0, cutoff: 150 }, "off keeps the cutoff");
    assert.equal(draftDirty(r1, d), false);
    // Turning an enabled notch off keeps its cutoff and never writes cutoff 0.
    const on = notchRows(await readNotches(fakeHost({ ...v, gyro_notch1_hz: "200" }, { filters: report("ok", "yes") }).host))[0];
    const offDraft = { ...draftFromRow(on), enabled: false };
    assert.deepEqual(draftPair(offDraft), { center: 0, cutoff: 150 });
    const f = fakeHost({ ...v, gyro_notch1_hz: "200" });
    assert.deepEqual((await applyNotch(f.host, 1, loadedPair(on), draftPair(offDraft)!)).sent, ["set gyro_notch1_hz 0"]);
  });

  await test("client hint mirrors the pair rule only (no Nyquist math)", () => {
    assert.equal(draftProblem({ enabled: true, center: "200", cutoff: "150" }), null);
    assert.equal(draftProblem({ enabled: true, center: "1000", cutoff: "600" }), null, "the FC decides the loop-rate limit");
    assert.ok(draftProblem({ enabled: true, center: "10", cutoff: "5" }));
    assert.ok(draftProblem({ enabled: true, center: "200", cutoff: "250" }));
    assert.ok(draftProblem({ enabled: true, center: "", cutoff: "150" }));
    assert.equal(draftProblem({ enabled: false, center: "", cutoff: "150" }), null);
  });

  await test("set then re-read with get: UI shows what the FC holds, not what was sent", async () => {
    const host = await mockHost("off");
    const before = notchRows(await readNotches(host))[1];
    const res = await applyNotch(host, 2, loadedPair(before), { center: 200, cutoff: 150 });
    assert.deepEqual(res, { ok: true, sent: ["set gyro_notch2_cutoff_hz 150", "set gyro_notch2_hz 200"] });
    const after = notchRows(await readNotches(host))[1];
    assert.deepEqual([after.center, after.cutoff, after.active, after.reason], ["200", "150", "yes", "ok"]);
    await host.disconnect();
    // An FC that answers ok but keeps another value: the re-read wins.
    const vals: Record<string, string> = { gyro_notch1_hz: "0", gyro_notch1_cutoff_hz: "0", gyro_notch2_hz: "0", gyro_notch2_cutoff_hz: "0" };
    const f = fakeHost(vals, { filters: report("off") });
    assert.equal((await applyNotch(f.host, 1, { center: 0, cutoff: 0 }, { center: 200, cutoff: 150 })).ok, true);
    const [r] = notchRows(await readNotches(f.host));
    assert.equal(r.center, "0"); assert.equal(r.cutoff, "0");
  });

  await test("refused set: FC line shown exactly, value unchanged after re-read", async () => {
    const host = await mockHost("above-nyquist");
    const row = notchRows(await readNotches(host))[0];
    assert.deepEqual([row.center, row.reason], ["600", "above-nyquist"]);
    const line = "set failed: gyro_notch1_hz must be below 450 Hz at the running 1000 Hz loop rate";
    const res = await applyNotch(host, 1, loadedPair(row), draftPair({ enabled: true, center: "500", cutoff: "420" })!);
    assert.deepEqual(res, { ok: false, sent: ["set gyro_notch1_hz 500"], fcLine: line });
    const again = notchRows(await readNotches(host))[0];
    assert.deepEqual([again.center, again.cutoff, again.reason], ["600", "420", "above-nyquist"], "unchanged");
    // A refusal the UI hint does not know about still comes through verbatim.
    const odd = "set failed: gyro_notch1_hz blocked by something new";
    const f = fakeHost({ gyro_notch1_hz: "0", gyro_notch1_cutoff_hz: "0", gyro_notch2_hz: "0", gyro_notch2_cutoff_hz: "0" }, { setReply: (k) => (k === "gyro_notch1_hz" ? odd : null) });
    const r2 = await applyNotch(f.host, 1, { center: 0, cutoff: 0 }, { center: 200, cutoff: 150 });
    assert.equal(r2.ok, false); assert.equal(!r2.ok && r2.fcLine, odd);
    await host.disconnect();
  });

  await test("reload guard: page edits ask first, then the #54 storage guard", () => {
    const run = (pageDirty: boolean, fcDirty: boolean | null, answers: boolean[]) => {
      const asked: string[] = []; let reloads = 0;
      const ran = requestFiltersReload({ pageDirty, fcDirty, confirm: (m) => { asked.push(m); return answers.shift() ?? false; }, reload: () => { reloads++; }, requestRefresh });
      return { ran, asked, reloads };
    };
    assert.deepEqual(run(false, false, []), { ran: true, asked: [], reloads: 1 });
    assert.deepEqual(run(false, null, []), { ran: true, asked: [], reloads: 1 });
    assert.deepEqual(run(true, false, [false]), { ran: false, asked: [DISCARD_EDITS_MESSAGE], reloads: 0 });
    assert.deepEqual(run(true, false, [true]), { ran: true, asked: [DISCARD_EDITS_MESSAGE], reloads: 1 });
    assert.deepEqual(run(false, true, [false]), { ran: false, asked: [REFRESH_CONFIRM_MESSAGE], reloads: 0 });
    assert.deepEqual(run(true, true, [true, true]), { ran: true, asked: [DISCARD_EDITS_MESSAGE, REFRESH_CONFIRM_MESSAGE], reloads: 1 });
  });

  await test("CLI tab accepts the notch lines", () => {
    for (const l of ["filters", "get gyro_notch1_hz", "set gyro_notch2_cutoff_hz 150"]) assert.ok(parseCliInput(l), l);
  });

  await test("FiltersPage wiring: re-read after set, verbatim FC line, #54 guard, no Nyquist math, no StoragePanel blocked", () => {
    const page = code(source("../src/pages/FiltersPage.tsx"));
    const ctl = code(source("../src/filters/gyroNotch.ts"));
    for (const t of [page, ctl]) {
      assert.ok(!/0\.45|0\.9\s*\*|\/\s*2\b|nyquist\s*[(=*]|sampleHz\s*[*/<>]/i.test(t), "no Nyquist math in the UI");
      assert.ok(!/StoragePanel|blocked/.test(t), "does not render or feed StoragePanel blocked");
    }
    assert.ok(/requestFiltersReload\(\{[\s\S]*requestRefresh,?[\s\S]*\}\)/.test(page), "reload goes through the #54 guard");
    assert.ok(/import \{[^}]*requestRefresh[^}]*\} from "\.\.\/components\/storageRefresh"/.test(page));
    const save = page.slice(page.indexOf("async function onSave"), page.indexOf("async function onDefaults"));
    assert.ok(/applyNotch\([\s\S]*setNotchFcLine\(res\.fcLine\)[\s\S]*await reloadNotches\(\)[\s\S]*return;/.test(save), "refused set: verbatim line, re-read");
    assert.ok(save.indexOf("await reloadNotches()", save.lastIndexOf("applyNotch(")) < save.indexOf("host.saveSettings()"), "re-read before save");
    assert.ok(!/setDrafts\(/.test(save) && !/setNotchSnap\(/.test(save), "no optimistic update in save");
    assert.ok(/\{notchFcLine\}/.test(page), "FC line rendered as-is");
    assert.ok(/disabled=\{!r\.supported \|\| !d\.enabled\}\s*value=\{r\.supported \? d\.cutoff : r\.cutoff\}/.test(page), "cutoff disabled while off but still shows its value");
    assert.ok(/<code>\{r\.active\}<\/code>/.test(page) && /<code>\{r\.reason\}<\/code>/.test(page), "active/reason verbatim");
    assert.ok(!/no notches/.test(source("../src/pages/FiltersPage.tsx")));
    assert.ok(/\^set failed: /.test(page), "FC set failure text kept verbatim in the page error path");
  });

  // SettingsKey type stays in sync with the notch keys.
  const k: SettingsKey = "gyro_notch2_cutoff_hz"; void k;
  console.log(`gyro-notch UI: ${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
