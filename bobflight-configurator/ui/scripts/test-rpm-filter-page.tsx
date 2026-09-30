/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for the RPM filter (FW schema 9): the real FiltersPage section
 * and the Motors-tab MotorPolesPanel, in the #57 fake DOM (FiltersPage's
 * useHost stubbed by run-rpm-filter-page.mjs) over the UI mock host's RPM
 * scenarios. Asserts what a user sees: visible status/motor cells per mock,
 * FC tokens verbatim (unknown and malformed tokens included), inputs after a
 * refused or accepted Save, the FC refusal line verbatim, the command order
 * (set -> get <key> -> rpm_filter, all before save) and that no eRPM is read
 * to compute a frequency on the client.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FiltersPage } from "../src/pages/FiltersPage";
import { MotorPolesPanel } from "../src/motors/MotorPolesPanel";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { RPM_FILTER_MOCK_SCENARIOS, type RpmFilterMockScenario } from "../../protocol/src/rpm-filter-mock";
import { STORAGE_SCOPE_V8, STORAGE_SCOPE_V9 } from "../../protocol/src/storage";
import type { CliCommand, SettingsKey } from "../src/protocol";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// ---- DOM reading -------------------------------------------------------------
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTag = (tag: string) => container.findAll((e) => e.tagName === tag);
const byAttr = (a: string, v?: string) => container.findAll((e) => (v === undefined ? e.hasAttribute(a) : e.getAttribute(a) === v));
function status(label: "Filter rate (Hz)" | "Harmonics running" | "Filter active" | "Filter reason"): string {
  const tr = byAttr("data-rpm-status", "1")[0];
  assert.ok(tr, "tr[data-rpm-status] rendered");
  const ths = tr.parentNode!.parentNode!.findAll((e) => e.tagName === "TH").map((th) => visibleText(th));
  const idx = ths.indexOf(label);
  assert.ok(idx >= 0, `column ${label}`);
  return visibleText(tr.childNodes.filter(isEl)[idx]).trim();
}
function motors(): string[] {
  return [1, 2, 3, 4].map((m) => {
    const tr = byAttr("data-rpm-motor", String(m))[0];
    assert.ok(tr, `tr[data-rpm-motor=${m}]`);
    return visibleText(tr.childNodes.filter(isEl)[1]).trim();
  });
}
function input(label: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === label)[0];
  assert.ok(el, `input ${label}`);
  return el;
}
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function button(text: string): FakeElement {
  const b = byTag("BUTTON").find((e) => visibleText(e).startsWith(text));
  assert.ok(b, `button ${text}`);
  return b;
}
const testId = (id: string) => { const p = byAttr("data-testid", id)[0]; return p ? visibleText(p) : null; };
const poles = () => visibleText(byAttr("data-rpm", "motor_poles")[0]).trim();
const failText = () => container.findAll((e) => e.tagName === "P" && e.getAttribute("class") === "fail").map(visibleText);
const lastReply = () => container.findAll((e) => e.tagName === "P" && visibleText(e).startsWith("Last reply: ")).map(visibleText)[0] ?? null;

function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
async function type(el: FakeElement, value: string) { flushSync(() => reactProps(el).onChange({ target: { value }, currentTarget: { value } })); await sleep(0); }
async function click(el: FakeElement) { flushSync(() => reactProps(el).onClick({})); await sleep(0); }

// ---- host rig -----------------------------------------------------------------
const storageReply = (schema: number) => ["storage_api: 1", "backend: flash", `schema: ${schema}`, "state: saved", "dirty: 0",
  "generation: 2", "last_error: none", `scope: ${schema >= 9 ? STORAGE_SCOPE_V9 : STORAGE_SCOPE_V8}`, "armed: 0", "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", "storage_end: 1"].join("\r\n") + "\r\n";

interface RigOpts { rpmReport?: string; }
async function mockHost(scenario: RpmFilterMockScenario, o: RigOpts = {}) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, gyroNotchScenario: "off", rpmFilterScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const ops: string[] = [];
  let loads = 0;
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    onLine: (fn: (l: string) => void) => mock.onLine(fn),
    getAllSettings: async () => { ops.push("getAll"); return mock.getAllSettings(); },
    getSetting: async (key: SettingsKey) => { ops.push(`get ${key}`); return mock.getSetting(key); },
    setSetting: async (key: SettingsKey, value: string) => { ops.push(`set ${key} ${value}`); return mock.setSetting(key, value); },
    sendCommand: async (cmd: CliCommand) => {
      ops.push(cmd);
      if (cmd === "rpm_filter" && o.rpmReport !== undefined) return o.rpmReport;
      if (cmd === "storage") { loads++; return storageReply(scenario === "old-fc" ? 8 : 9); }
      return mock.sendCommand(cmd);
    },
    saveSettings: async () => { ops.push("save"); },
    restoreDefaults: async () => { ops.push("defaults"); },
  };
  return { mock, host, ops, loads: () => loads };
}
async function rig(scenario: RpmFilterMockScenario, o: RigOpts = {}) {
  const h = await mockHost(scenario, o);
  (globalThis as Record<string, unknown>).__setupTestHost = {
    host: h.host, connectionStatus: "connected", version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
  };
  const root: Root = createRoot(container as never);
  flushSync(() => root.render(<FiltersPage />));
  assert.ok(await waitFor(() => h.loads() >= 1 && h.ops.includes("rpm_filter")), "initial load read storage and rpm_filter");
  await sleep(20);
  const rereadAfter = async (from: number, what: string) => { assert.ok(await waitFor(() => from >= 0 && h.ops.indexOf("storage", from + 1) > from), `re-read after ${what}: ${JSON.stringify(h.ops)}`); await sleep(20); };
  return { ...h, root, rereadAfter, done: async () => { root.unmount(); await h.mock.disconnect(); } };
}

const report = (o: { reason?: string; active?: string; running?: string } = {}) => ["rpm_filter_api: 1", "rpm_filter_sample_hz: 4000", "rpm_filter_harmonics: 3",
  `rpm_filter_harmonics_active: ${o.running ?? "3"}`, `rpm_filter_active: ${o.active ?? "yes"}`, `rpm_filter_reason: ${o.reason ?? "ok"}`,
  "rpm_filter_m1_hz: 180", "rpm_filter_m2_hz: 182", "rpm_filter_m3_hz: 179", "rpm_filter_m4_hz: 185", "rpm_filter_end: 1"].join("\r\n") + "\r\n";

let passed = 0;
/** ONLY=<substring> runs just the matching tests (used to show which test catches a mutation). */
const only = process.env.ONLY;
async function test(name: string, fn: () => Promise<void>) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await test("each RPM mock: visible status and motor cells are the FC tokens (C1)", async () => {
    const U = "unavailable";
    const live = ["180", "182", "179", "185"];
    const expected: Record<RpmFilterMockScenario, { h: string; rate: string; run: string; act: string; reason: string; m: string[]; banner: boolean }> = {
      off: { h: "0", rate: "4000", run: "0", act: "no", reason: "off", m: [U, U, U, U], banner: false },
      ok: { h: "3", rate: "4000", run: "3", act: "yes", reason: "ok", m: live, banner: false },
      "bidir-off": { h: "2", rate: "4000", run: "0", act: "no", reason: "bidir-off", m: [U, U, U, U], banner: true },
      "erpm-unavailable": { h: "2", rate: "4000", run: "0", act: "no", reason: "erpm-unavailable", m: [U, U, U, U], banner: false },
      "trimmed-1k": { h: "3", rate: "1000", run: "1", act: "yes", reason: "ok", m: live, banner: false },
      "old-fc": { h: "unknown", rate: "unknown", run: "unknown", act: "unknown", reason: "unknown", m: ["unknown", "unknown", "unknown", "unknown"], banner: false },
      "off-erpm-live": { h: "0", rate: "4000", run: "0", act: "no", reason: "off", m: [U, U, U, U], banner: false },
    };
    for (const s of RPM_FILTER_MOCK_SCENARIOS) {
      const t = await rig(s);
      const e = expected[s];
      assert.equal(input("rpm_filter_harmonics").value, e.h, `${s}: harmonics input`);
      assert.deepEqual([status("Filter rate (Hz)"), status("Harmonics running"), status("Filter active"), status("Filter reason")], [e.rate, e.run, e.act, e.reason], `${s}: status cells`);
      assert.deepEqual(motors(), e.m, `${s}: motor cells`);
      assert.equal(testId("rpm-bidir-off") !== null, e.banner, `${s}: bidir-off banner`);
      if (s === "old-fc") {
        for (const k of ["rpm_filter_harmonics", "rpm_filter_min_hz", "rpm_filter_q"]) { assert.ok(isDisabled(input(k)), `${k} disabled`); assert.equal(input(k).value, "unknown", `${k} unknown, never 0/off`); }
        assert.equal(poles(), "unknown");
      } else {
        assert.deepEqual([input("rpm_filter_min_hz").value, input("rpm_filter_q").value, poles()], ["100", "5", "14"], `${s}: min, Q shown /100, poles`);
      }
      await t.done();
    }
  });

  await test("unknown future tokens are shown verbatim (not mapped to ok/off)", async () => {
    const t = await rig("ok", { rpmReport: report({ reason: "esc-fallback", active: "partial", running: "2" }) });
    assert.deepEqual([status("Filter reason"), status("Filter active"), status("Harmonics running")], ["esc-fallback", "partial", "2"]);
    assert.equal(testId("rpm-bidir-off"), null, "banner only for the FC's bidir-off token");
    await t.done();
  });

  await test("malformed token 'bidir off' -> reason 'unknown' (no banner, no loosened parse)", async () => {
    const t = await rig("bidir-off", { rpmReport: report({ reason: "bidir off", active: "no", running: "0" }) });
    assert.equal(status("Filter reason"), "unknown");
    assert.equal(testId("rpm-bidir-off"), null);
    await t.done();
  });

  await test("off-erpm-live: motor cells unavailable and no eRPM is read on the Filters tab", async () => {
    const t = await rig("off-erpm-live");
    assert.equal((await t.mock.sendCommand("get erpm_m1")).trim(), "erpm_m1=75600", "the FC does have live eRPM");
    t.ops.length = 0;
    await click(button("Reload"));
    assert.ok(await waitFor(() => t.ops.includes("rpm_filter")), JSON.stringify(t.ops));
    await sleep(30);
    assert.deepEqual(motors(), ["unavailable", "unavailable", "unavailable", "unavailable"]);
    assert.ok(!t.ops.some((op) => /erpm/.test(op)), `no erpm read: ${JSON.stringify(t.ops)}`);
    await t.done();
  });

  await test("refused set through Save (armed): FC line verbatim, inputs show what the FC holds, no save (R3)", async () => {
    const t = await rig("ok");
    assert.equal((await t.mock.sendCommand("arm")).trim(), "armed");
    await type(input("rpm_filter_harmonics"), "1");
    await type(input("rpm_filter_q"), "3.5");
    const before = t.ops.length;
    await click(button("Save"));
    assert.ok(await waitFor(() => testId("rpm-fc-line") !== null), `FC line rendered; fail=${JSON.stringify(failText())}`);
    await t.rereadAfter(t.ops.indexOf("set rpm_filter_harmonics 1", before), "the refused set");
    assert.equal(testId("rpm-fc-line"), "set failed: armed", "FC line exactly as sent");
    assert.equal((await t.mock.getSetting("rpm_filter_harmonics" as SettingsKey)).value, "3", "FC value unchanged");
    assert.equal(input("rpm_filter_harmonics").value, "3", "input shows the FC value, not the refused 1");
    assert.equal(input("rpm_filter_q").value, "5", "unsent edit also returns to the FC value");
    const after = t.ops.slice(before);
    const set = after.indexOf("set rpm_filter_harmonics 1");
    assert.ok(set >= 0 && after[set + 1] === "get rpm_filter_harmonics" && after[set + 2] === "rpm_filter", JSON.stringify(after));
    assert.ok(!after.some((op) => op.startsWith("set rpm_filter_q_x100")), "stops at the first refusal");
    assert.ok(!after.includes("save"), "nothing saved after a refusal");
    await t.done();
  });

  await test("accepted Save: set -> get <key> -> rpm_filter per key, all before save; Q sent x100", async () => {
    const t = await rig("off");
    await type(input("rpm_filter_harmonics"), "2");
    await type(input("rpm_filter_min_hz"), "120");
    await type(input("rpm_filter_q"), "3.5");
    const before = t.ops.length;
    await click(button("Save"));
    assert.ok(await waitFor(() => lastReply() === "Last reply: saved"), `saved; fail=${JSON.stringify(failText())}`);
    await t.rereadAfter(t.ops.indexOf("save", before), "save");
    const ops = t.ops.slice(before);
    const save = ops.indexOf("save");
    const sets = ops.map((op, i) => ({ op, i })).filter(({ op }) => /^set (rpm_filter|motor_poles)/.test(op));
    assert.deepEqual(sets.map((s) => s.op), ["set rpm_filter_harmonics 2", "set rpm_filter_min_hz 120", "set rpm_filter_q_x100 350"]);
    for (const { op, i } of sets) {
      const key = op.split(" ")[1];
      assert.deepEqual(ops.slice(i + 1, i + 3), [`get ${key}`, "rpm_filter"], `${op} re-read: ${JSON.stringify(ops)}`);
      assert.ok(i + 2 < save, `${op} before save`);
    }
    assert.deepEqual([input("rpm_filter_harmonics").value, input("rpm_filter_min_hz").value, input("rpm_filter_q").value], ["2", "120", "3.5"]);
    assert.deepEqual([status("Filter reason"), status("Harmonics running")], ["ok", "2"]);
    assert.deepEqual(motors(), ["180", "182", "179", "185"], "FC-computed Hz");
    await t.done();
  });

  await test("client hint is not FW text and sends nothing", async () => {
    const t = await rig("off");
    await type(input("rpm_filter_harmonics"), "4");
    assert.ok(testId("rpm-hint"), "hint shown");
    const before = t.ops.length;
    await click(button("Save"));
    await sleep(30);
    assert.ok(failText().every((m) => !/set failed/i.test(m)), JSON.stringify(failText()));
    assert.deepEqual(t.ops.slice(before), [], "nothing sent");
    await t.done();
  });

  // ---- Motors tab: motor_poles ---------------------------------------------------
  async function poleRig(scenario: RpmFilterMockScenario) {
    const h = await mockHost(scenario);
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={h.host} fallback={<p data-testid="browser-poles">browser preference</p>} />));
    assert.ok(await waitFor(() => h.ops.includes("get motor_poles")));
    await sleep(30);
    return { ...h, done: async () => { root.unmount(); await h.mock.disconnect(); } };
  }

  await test("motor_poles on the Motors tab: set -> get -> rpm_filter, input shows the FC value", async () => {
    const t = await poleRig("ok");
    assert.equal(input("motor_poles").value, "14");
    assert.equal(testId("browser-poles"), null, "FC setting replaces the browser preference");
    await type(input("motor_poles"), "12");
    const before = t.ops.length;
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => poles() === "12"), `FC now holds 12: ${JSON.stringify(t.ops)}`);
    assert.deepEqual(t.ops.slice(before), ["set motor_poles 12", "get motor_poles", "rpm_filter"]);
    assert.equal(input("motor_poles").value, "12");
    await t.done();
  });

  await test("motor_poles refused (armed): FC line verbatim and input back to the FC value (R3)", async () => {
    const t = await poleRig("ok");
    await t.mock.sendCommand("arm");
    await type(input("motor_poles"), "12");
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => testId("motor-poles-fc-line") !== null));
    assert.equal(testId("motor-poles-fc-line"), "set failed: armed");
    assert.equal(input("motor_poles").value, "14");
    assert.equal(poles(), "14");
    await t.done();
  });

  await test("motor_poles on an older FC: browser preference fallback, nothing set", async () => {
    const t = await poleRig("old-fc");
    assert.ok(await waitFor(() => testId("browser-poles") !== null));
    assert.ok(!t.ops.some((op) => op.startsWith("set ")), JSON.stringify(t.ops));
    await t.done();
  });

  console.log(`PASS RPM filter render: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exitCode = 1; });
