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
 *
 * #60 review: no op ever matches /dshot_bidir/ (every scenario, Save in
 * bidir-off, the poles panel); active-partial keeps m2 "unavailable"; the
 * real MotorsPage passes `blocked` (post-flash gate, stop in flight) to the
 * poles panel; invalid pole drafts (13, 38) send nothing; the panel re-reads
 * on reconnect, shows "unknown" and the FC reason token verbatim; the
 * schema < 9 downgrade guard; strict numeric report fields.
 *
 * QA #60 (busy gate): the stub host above has no CommandGate, which is how
 * CI missed that the poles panel's one-shot read was refused while the
 * Motors eRPM poll held the gate. `gatedHost` wires the REAL CommandGate
 * exactly as ProtocolHostAdapter (createHost) does. Asserted: the value shows
 * once the gate frees (also on the real MotorsPage with its real poll), the
 * older-FC fallback returns, a refused set / report is retried and sent once,
 * a FW refusal and a malformed value are never retried, an accepted set is
 * never re-sent, an exhausted retry shows
 * "unknown" + the gate's message, and unmount stops the retries.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FiltersPage } from "../src/pages/FiltersPage";
import { MotorPolesPanel } from "../src/motors/MotorPolesPanel";
import { MotorsPage } from "../src/pages/MotorsPage";
import { RPM_GATE_ATTEMPTS, RPM_GATE_DELAY_MS, readRpm, rpmView, type RpmSnapshot } from "../src/filters/rpmFilter";
import { CommandGate, GATE_BUSY_MESSAGE, isGateBusy } from "../src/protocol/commandGate";
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

interface RigOpts { rpmReport?: string; schema?: number; getValue?: Partial<Record<string, string>>; }
async function mockHost(scenario: RpmFilterMockScenario, o: RigOpts = {}) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, gyroNotchScenario: "off", rpmFilterScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const ops: string[] = [];
  let loads = 0;
  /** Commands held until released (e.g. `motor_test 0` to keep a Stop in flight). */
  const gates = new Map<string, Promise<void>>();
  const hold = (cmd: string) => { let release = () => {}; gates.set(cmd, new Promise<void>((r) => { release = () => { gates.delete(cmd); r(); }; })); return () => release(); };
  const logged: Record<string, (...a: never[]) => unknown> = {
    getAllSettings: async () => { ops.push("getAll"); return mock.getAllSettings(); },
    getSetting: async (key: SettingsKey) => {
      ops.push(`get ${key}`);
      const v = o.getValue?.[key];
      return v !== undefined ? { key, value: v } : mock.getSetting(key);
    },
    setSetting: async (key: SettingsKey, value: string) => { ops.push(`set ${key} ${value}`); return mock.setSetting(key, value); },
    sendCommand: async (cmd: CliCommand) => {
      ops.push(cmd);
      if (cmd === "rpm_filter" && o.rpmReport !== undefined) return o.rpmReport;
      if (cmd === "storage") { loads++; return storageReply(o.schema ?? (scenario === "old-fc" ? 8 : 9)); }
      const gate = gates.get(cmd);
      if (gate) await gate;
      return mock.sendCommand(cmd);
    },
    saveSettings: async () => { ops.push("save"); },
    restoreDefaults: async () => { ops.push("defaults"); },
  };
  // Every other host method (onStatus, getStatus, ...) is the mock's own.
  const host = new Proxy(mock, {
    get(target, prop) {
      if (typeof prop === "string" && prop in logged) return logged[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as MockBobFlightHost;
  return { mock, host, ops, hold, loads: () => loads };
}
const bidirOps = (ops: string[]) => ops.filter((op) => /dshot_bidir/.test(op));
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

const report = (o: { reason?: string; active?: string; running?: string } = {}) => ["rpm_filter_api: 1", `rpm_filter_active: ${o.active ?? "yes"}`,
  `rpm_filter_reason: ${o.reason ?? "ok"}`, "rpm_filter_sample_hz: 4000", `rpm_filter_harmonics_active: ${o.running ?? "3"}`,
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
      "active-partial": { h: "3", rate: "4000", run: "3", act: "yes", reason: "ok", m: ["180", U, "179", "185"], banner: false },
    };
    for (const s of RPM_FILTER_MOCK_SCENARIOS) {
      const t = await rig(s);
      const e = expected[s];
      assert.equal(input("rpm_filter_harmonics").value, e.h, `${s}: harmonics input`);
      assert.deepEqual([status("Filter rate (Hz)"), status("Harmonics running"), status("Filter active"), status("Filter reason")], [e.rate, e.run, e.act, e.reason], `${s}: status cells`);
      assert.deepEqual(motors(), e.m, `${s}: motor cells`);
      assert.equal(testId("rpm-bidir-off") !== null, e.banner, `${s}: bidir-off banner`);
      if (e.banner) {
        const b = testId("rpm-bidir-off")!;
        assert.ok(/Motors tab/.test(b) && !/set dshot_bidir/.test(b), `banner points only to the Motors tab (no CLI text): ${b}`);
      }
      assert.deepEqual(bidirOps(t.ops), [], `${s}: no op touches dshot_bidir: ${JSON.stringify(t.ops)}`);
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

  await test("Save in bidir-off: accepted, saved, bidir never enabled (no dshot_bidir op) (blocker 2 / B2)", async () => {
    const t = await rig("bidir-off");
    await type(input("rpm_filter_harmonics"), "3");
    await type(input("rpm_filter_min_hz"), "150");
    const before = t.ops.length;
    await click(button("Save"));
    assert.ok(await waitFor(() => lastReply() === "Last reply: saved"), `saved; fail=${JSON.stringify(failText())}`);
    await t.rereadAfter(t.ops.indexOf("save", before), "save");
    assert.deepEqual(bidirOps(t.ops), [], `no dshot_bidir op: ${JSON.stringify(t.ops)}`);
    assert.equal((await t.mock.sendCommand("get dshot_bidir")).trim(), "dshot_bidir=off", "FC bidir still off");
    assert.equal(status("Filter reason"), "bidir-off");
    assert.ok(testId("rpm-bidir-off"), "banner still shown");
    await t.done();
  });

  await test("active-partial: m2 stays unavailable although eRPM is live; no erpm op (blocker 3 / HZ2)", async () => {
    const t = await rig("active-partial");
    assert.equal((await t.mock.sendCommand("get erpm_m2")).trim(), "erpm_m2=76440", "the FC does have live M2 eRPM");
    assert.deepEqual([status("Filter active"), status("Filter reason")], ["yes", "ok"]);
    assert.deepEqual(motors(), ["180", "unavailable", "179", "185"], "initial load");
    t.ops.length = 0;
    await click(button("Reload"));
    assert.ok(await waitFor(() => t.ops.includes("rpm_filter")), JSON.stringify(t.ops));
    await sleep(30);
    assert.deepEqual(motors(), ["180", "unavailable", "179", "185"], "after Reload");
    assert.ok(!t.ops.some((op) => /erpm/.test(op)), `no erpm read: ${JSON.stringify(t.ops)}`);
    assert.deepEqual(bidirOps(t.ops), []);
    await t.done();
  });

  await test("strict report fields: 4OOO / -5 / 18.5 render unknown; a lowercase token is verbatim (nit 9)", async () => {
    const raw = ["rpm_filter_api: 1", "rpm_filter_active: yes", "rpm_filter_reason: ok", "rpm_filter_sample_hz: 4OOO", "rpm_filter_harmonics_active: -5",
      "rpm_filter_m1_hz: 18.5", "rpm_filter_m2_hz: 4OOO", "rpm_filter_m3_hz: -5", "rpm_filter_m4_hz: stale", "rpm_filter_end: 1"].join("\r\n") + "\r\n";
    const t = await rig("ok", { rpmReport: raw });
    assert.deepEqual([status("Filter rate (Hz)"), status("Harmonics running")], ["unknown", "unknown"]);
    assert.deepEqual(motors(), ["unknown", "unknown", "unknown", "stale"]);
    await t.done();
  });

  await test("schema < 9 downgrade guard: FC answering RPM keys but reporting schema 8 -> read-only unknown (nit 13 / O2b)", async () => {
    const full = await (async () => { const h = await mockHost("ok"); const snap: RpmSnapshot = await readRpm(h.host); await h.mock.disconnect(); return snap; })();
    assert.equal(rpmView(full, 9).supported, true);
    assert.equal(rpmView(full, null).supported, true, "schema unknown: the FC's own replies decide");
    for (const schema of [8, 1]) {
      const v = rpmView(full, schema);
      assert.equal(v.supported, false, `schema ${schema}`);
      for (const k of ["harmonics", "minHz", "q", "motorPoles", "sampleHz", "harmonicsActive", "active", "reason"] as const) assert.equal(v[k], "unknown", `schema ${schema}: ${k}`);
      assert.ok(v.motors.every((m) => m.hz === "unknown"));
    }
    const t = await rig("ok", { schema: 8 });
    assert.equal(input("rpm_filter_harmonics").value, "unknown");
    assert.ok(isDisabled(input("rpm_filter_harmonics")), "read-only");
    assert.deepEqual(motors(), ["unknown", "unknown", "unknown", "unknown"]);
    assert.equal(status("Filter reason"), "unknown");
    await t.done();
  });

  // ---- Motors tab: motor_poles ---------------------------------------------------
  async function poleRig(scenario: RpmFilterMockScenario, o: RigOpts = {}) {
    const h = await mockHost(scenario, o);
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

  for (const bad of ["13", "38"]) {
    await test(`motor_poles ${bad}: hint visible, button disabled, nothing sent (blocker 4)`, async () => {
      const t = await poleRig("ok");
      await type(input("motor_poles"), bad);
      assert.ok(testId("motor-poles-hint"), "hint shown");
      assert.match(testId("motor-poles-hint")!, /even pole count from 4 to 36/);
      assert.ok(isDisabled(button("Set on controller")), "button disabled while the hint shows");
      const before = t.ops.length;
      await click(button("Set on controller"));
      await sleep(40);
      assert.deepEqual(t.ops.slice(before), [], "no op sent");
      assert.equal(poles(), "14", "FC value unchanged");
      await t.done();
    });
  }

  await test("motor_poles in bidir-off: set -> get -> rpm_filter only, never a dshot_bidir op (blocker 2)", async () => {
    const t = await poleRig("bidir-off");
    await type(input("motor_poles"), "12");
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => poles() === "12"));
    assert.deepEqual(bidirOps(t.ops), [], JSON.stringify(t.ops));
    assert.equal(visibleText(byAttr("data-rpm", "reason")[0]), "bidir-off");
    await t.done();
  });

  await test("poles panel: reason token verbatim (known and future tokens) (nit 7 / C1p)", async () => {
    for (const [scenario, rep, want] of [["erpm-unavailable", undefined, "erpm-unavailable"], ["ok", report({ reason: "esc-fallback", active: "partial", running: "2" }), "esc-fallback"]] as const) {
      const t = await poleRig(scenario, rep ? { rpmReport: rep } : {});
      assert.equal(visibleText(byAttr("data-rpm", "reason")[0]), want, scenario);
      await t.done();
    }
  });

  await test("poles panel: malformed FC value -> 'unknown', input and button disabled (nit 7 / MP7)", async () => {
    for (const raw of ["abc", ""]) {
      const t = await poleRig("ok", { getValue: { motor_poles: raw } });
      assert.equal(poles(), "unknown", `get motor_poles -> ${JSON.stringify(raw)}`);
      assert.ok(isDisabled(input("motor_poles")) && isDisabled(button("Set on controller")));
      assert.equal(testId("browser-poles"), null, "not the older-FC fallback");
      await t.done();
    }
  });

  await test("poles panel re-reads when the connection status changes (nit 6)", async () => {
    const t = await poleRig("ok");
    assert.equal(poles(), "14");
    await t.mock.disconnect();
    assert.ok(await waitFor(() => poles() === "reading…"), `stale value dropped on disconnect: ${poles()}`);
    assert.ok(isDisabled(input("motor_poles")));
    const before = t.ops.length;
    await t.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    assert.ok(await waitFor(() => t.ops.indexOf("get motor_poles", before) >= 0 && poles() === "14"), `re-read after reconnect: ${JSON.stringify(t.ops.slice(before))}`);
    assert.ok(!isDisabled(input("motor_poles")));
    await t.done();
  });

  // ---- real MotorsPage: the poles panel honours the storage lock (blocker 1) ---------
  async function motorsPage(postFlashGate: boolean) {
    // MotorsPage reads page visibility; the fake DOM has no global document, so lend a
    // visibility-only one for this render and remove it afterwards.
    (globalThis as Record<string, unknown>).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    const h = await mockHost("ok");
    (globalThis as Record<string, unknown>).__setupTestHost = {
      host: h.host, connectionStatus: "connected", version: "BobFlight test", status: null,
      refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate,
    };
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorsPage />));
    assert.ok(await waitFor(() => byAttr("data-testid", "motor-poles-fc").length > 0 && poles() === "14"), `poles panel rendered: ${JSON.stringify(h.ops)}`);
    return { ...h, done: async () => { root.unmount(); await sleep(20); await h.mock.disconnect(); delete (globalThis as Record<string, unknown>).document; } };
  }
  const polesLocked = () => isDisabled(input("motor_poles")) && isDisabled(button("Set on controller"));

  await test("MotorsPage post-flash gate: poles input and button disabled, click sends nothing (blocker 1)", async () => {
    const t = await motorsPage(true);
    await type(input("motor_poles"), "12");
    assert.ok(polesLocked(), "both disabled under the post-flash gate");
    const before = t.ops.length;
    await click(button("Set on controller"));
    await sleep(40);
    assert.ok(!t.ops.slice(before).some((op) => /motor_poles/.test(op) && op.startsWith("set")), JSON.stringify(t.ops.slice(before)));
    assert.equal((await t.mock.getSetting("motor_poles" as SettingsKey)).value, "14");
    await t.done();
  });

  await test("MotorsPage stop in flight (storageBlocked): poles locked until the stop settles (blocker 1)", async () => {
    const t = await motorsPage(false);
    assert.ok(await waitFor(() => !isDisabled(input("motor_poles"))), "unlocked when idle");
    await type(input("motor_poles"), "12");
    assert.ok(!isDisabled(button("Set on controller")), "enabled when idle with a valid draft");
    const release = t.hold("motor_test 0");
    await click(button("Stop all motor tests"));
    assert.ok(await waitFor(() => polesLocked()), "locked while the stop is in flight");
    const before = t.ops.length;
    await click(button("Set on controller"));
    await sleep(40);
    assert.ok(!t.ops.slice(before).some((op) => op === "set motor_poles 12"), "nothing set during the stop");
    release();
    assert.ok(await waitFor(() => !isDisabled(button("Set on controller"))), "unlocked after the stop settles");
    assert.deepEqual(bidirOps(t.ops), [], "Motors page never touches dshot_bidir on its own");
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

  // ---- QA #60: the REAL CommandGate (as wired by ProtocolHostAdapter / createHost) ----
  /** The rig's host behind a real CommandGate: every FC command takes the gate, refusals are
   * recorded in `refused` (nothing sent), what reached the FC is in `ops`. `latencyMs` models
   * the serial round trip so a poll burst really holds the gate. `grabAfterSet` makes another
   * command take the gate right after a set completes (before the panel's `get`);
   * `grabAfterGet` does the same right after `get motor_poles` (before `rpm_filter`).
   * `grabAfter` takes the gate once, right after the named command completes (e.g. `storage`, the
   * Filters page's last notch read, so only the RPM reads meet the busy gate); held until
   * `grab.release()` (or `ms`). */
  async function gatedHost(scenario: RpmFilterMockScenario, o: RigOpts & { latencyMs?: number; grabAfterSet?: number; grabAfterGet?: number;
    grabAfter?: { op: string; ms?: number } } = {}) {
    const h = await mockHost(scenario, o);
    const gate = new CommandGate(() => 1);
    const refused: string[] = [];
    const inner = h.host;
    const grab: { release: () => void; done: Promise<unknown> } = { release: () => {}, done: Promise.resolve() };
    let grabbed = false;
    const g = <T,>(label: string, work: () => Promise<T>, stop = false): Promise<T> =>
      gate.run(async () => { if (o.latencyMs) await sleep(o.latencyMs); return work(); }, stop)
        .then((r) => {
          if (o.grabAfter && !grabbed && label === o.grabAfter.op) {
            grabbed = true; const held = holdGate("get erpm_m4"); Object.assign(grab, held);
            if (o.grabAfter.ms !== undefined) setTimeout(held.release, o.grabAfter.ms);
          }
          return r;
        }, (e: unknown) => { if (isGateBusy(e)) refused.push(label); throw e; });
    /** Hold the gate like an in-flight poll command; returns release + the command's promise. */
    const holdGate = (label = "get erpm_m1") => { const release = h.hold(label); const done = inner.sendCommand(label as CliCommand).catch(() => "");
      const p = g(label, () => done); return { release, done: p }; };
    const wrapped: Record<string, unknown> = {
      getStatus: () => g("status", () => inner.getStatus()),
      getVersion: () => g("version", () => inner.getVersion()),
      getAllSettings: () => g("getAll", () => inner.getAllSettings()),
      getSetting: async (key: SettingsKey) => {
        const r = await g(`get ${key}`, () => inner.getSetting(key));
        if (o.grabAfterGet && key === "motor_poles") { const held = holdGate("get erpm_m3"); setTimeout(held.release, o.grabAfterGet); }
        return r;
      },
      setSetting: async (key: SettingsKey, value: string) => {
        const r = await g(`set ${key} ${value}`, () => inner.setSetting(key, value));
        if (o.grabAfterSet) { const held = holdGate("get erpm_m2"); setTimeout(held.release, o.grabAfterSet); }
        return r;
      },
      sendCommand: (cmd: CliCommand) => g(cmd, () => inner.sendCommand(cmd), cmd === "motor_test 0"),
      saveSettings: () => g("save", () => inner.saveSettings()),
      restoreDefaults: () => g("defaults", () => inner.restoreDefaults()),
    };
    const host = new Proxy(inner, {
      get(target, prop) {
        if (typeof prop === "string" && prop in wrapped) return wrapped[prop];
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as MockBobFlightHost;
    return { ...h, host, gate, refused, holdGate, grab };
  }
  /** The real FiltersPage on a (gated) host. */
  function mountFilters(host: MockBobFlightHost): Root {
    (globalThis as Record<string, unknown>).__setupTestHost = {
      host, connectionStatus: "connected", version: "BobFlight test", status: null,
      refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
    };
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<FiltersPage />));
    return root;
  }
  const rpmSection = () => visibleText(byAttr("data-testid", "rpm-filter")[0]);
  const rpmInputs = ["rpm_filter_harmonics", "rpm_filter_min_hz", "rpm_filter_q"];
  const rpmOps = (ops: string[]) => ops.filter((op) => /rpm_filter|motor_poles/.test(op));
  const fallbackEl = <p data-testid="browser-poles">browser preference</p>;
  const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;

  await test("real gate: poles panel mounted while an eRPM poll holds the gate shows the FC value once it frees (QA #60)", async () => {
    const t = await gatedHost("ok");
    const poll = t.holdGate("get erpm_m1");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => t.refused.includes("get motor_poles"), 1000), `the panel's read was refused by the busy gate: ${JSON.stringify(t.refused)}`);
    await sleep(250);
    assert.ok(!t.ops.includes("get motor_poles"), `nothing reached the FC while the gate was held: ${JSON.stringify(t.ops)}`);
    assert.equal(poles(), "reading…", "still retrying: not 'unknown' / malformed while the gate is busy");
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => poles() === "14", 1500), `value shows after the gate frees: ${poles()} ops=${JSON.stringify(t.ops)}`);
    assert.deepEqual(t.ops.filter((op) => op !== "get erpm_m1"), ["get motor_poles", "rpm_filter"], "get -> rpm_filter, each sent once");
    assert.equal(input("motor_poles").value, "14");
    assert.ok(!isDisabled(input("motor_poles")), "editable");
    assert.equal(testId("motor-poles-busy"), null);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate + real MotorsPage poll: poles panel shows the FC value (QA #60)", async () => {
    (globalThis as Record<string, unknown>).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    const t = await gatedHost("ok", { latencyMs: 5 });
    (globalThis as Record<string, unknown>).__setupTestHost = {
      host: t.host, connectionStatus: "connected", version: "BobFlight test", status: null,
      refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
    };
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorsPage />));
    assert.ok(await waitFor(() => byAttr("data-testid", "motor-poles-fc").length > 0 && poles() === "14", 4000),
      `poles panel shows the FC value under the real poll: "${byAttr("data-testid", "motor-poles-fc").length ? poles() : "(no panel)"}" refused=${JSON.stringify(t.refused)}`);
    assert.ok(t.refused.includes("get motor_poles"), `the race happened (the poll held the gate at mount): ${JSON.stringify(t.refused)}`);
    assert.equal(count(t.ops, "get motor_poles"), 1, "motor_poles read reached the FC exactly once");
    assert.ok(t.ops.indexOf("rpm_filter") > t.ops.indexOf("get motor_poles"), "get -> rpm_filter");
    assert.ok(!isDisabled(input("motor_poles")), "editable when idle");
    root.unmount(); await sleep(20); await t.mock.disconnect(); delete (globalThis as Record<string, unknown>).document;
  });

  await test("real gate: older FC behind a busy gate -> browser preference fallback returns (QA #60)", async () => {
    const t = await gatedHost("old-fc");
    const poll = t.holdGate("get erpm_m1");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => t.refused.includes("get motor_poles"), 1000));
    await sleep(150);
    assert.equal(testId("browser-poles"), null, "no fallback while the read is only refused by the gate");
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => testId("browser-poles") !== null, 1500), "older-FC fallback after the FC answers 'unknown key'");
    assert.ok(!t.ops.some((op) => op.startsWith("set ")), JSON.stringify(t.ops));
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: FW refusal ('set failed: armed') is sent once, shown verbatim, never retried (QA #60)", async () => {
    const t = await gatedHost("ok");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => poles() === "14"));
    await t.mock.sendCommand("arm");
    await type(input("motor_poles"), "12");
    const before = t.ops.length;
    const t0 = Date.now();
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => testId("motor-poles-fc-line") !== null, 1500));
    assert.equal(testId("motor-poles-fc-line"), "set failed: armed");
    assert.deepEqual(t.ops.slice(before), ["set motor_poles 12", "get motor_poles", "rpm_filter"], "set sent once, then get -> rpm_filter");
    assert.ok(Date.now() - t0 < 2 * RPM_GATE_DELAY_MS + 500, `no retry delay: ${Date.now() - t0} ms`);
    assert.equal(poles(), "14");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: an accepted set is never re-sent; only the get waits for the gate (QA #60)", async () => {
    const t = await gatedHost("ok", { grabAfterSet: 250 });
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => poles() === "14"));
    await type(input("motor_poles"), "12");
    const before = t.ops.length;
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => poles() === "12", 2000), `FC holds 12: ${JSON.stringify(t.ops.slice(before))}`);
    assert.ok(t.refused.includes("get motor_poles"), `the get after the set was refused by the gate: ${JSON.stringify(t.refused)}`);
    assert.deepEqual(t.ops.slice(before).filter((op) => op !== "get erpm_m2"), ["set motor_poles 12", "get motor_poles", "rpm_filter"],
      "set exactly once, then get -> rpm_filter");
    assert.equal(testId("motor-poles-fc-line"), null);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a set refused by the busy gate is retried, then sent once (QA #60)", async () => {
    const t = await gatedHost("ok");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => poles() === "14"));
    await type(input("motor_poles"), "12");
    const before = t.ops.length;
    const poll = t.holdGate("get erpm_m1");
    await click(button("Set on controller"));
    assert.ok(await waitFor(() => t.refused.includes("set motor_poles 12"), 1000), `the set was refused by the busy gate: ${JSON.stringify(t.refused)}`);
    await sleep(250);
    assert.ok(!t.ops.slice(before).includes("set motor_poles 12"), "nothing set while the gate is held");
    assert.equal(testId("motor-poles-fc-line"), null, "no error line while retrying");
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => poles() === "12", 1500), `FC holds 12 after the gate frees: ${JSON.stringify(t.ops.slice(before))}`);
    assert.deepEqual(t.ops.slice(before).filter((op) => op !== "get erpm_m1"), ["set motor_poles 12", "get motor_poles", "rpm_filter"], "set once, then get -> rpm_filter");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: the rpm_filter report refused after the get is retried (reason shows) (QA #60)", async () => {
    const t = await gatedHost("ok", { grabAfterGet: 250 });
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => t.refused.includes("rpm_filter"), 1000), `the report was refused by the busy gate: ${JSON.stringify(t.refused)}`);
    assert.ok(await waitFor(() => byAttr("data-rpm", "reason").length > 0, 1500), `reason shows once the gate frees: ${JSON.stringify(t.ops)}`);
    assert.equal(visibleText(byAttr("data-rpm", "reason")[0]), "ok");
    assert.equal(poles(), "14");
    assert.equal(count(t.ops, "rpm_filter"), 1, "report sent once");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a malformed FC value is not retried (one get, 'unknown', no busy line) (QA #60)", async () => {
    const t = await gatedHost("ok", { getValue: { motor_poles: "abc" } });
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => poles() === "unknown", 1000), poles());
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.equal(count(t.ops, "get motor_poles"), 1, `one get only: ${JSON.stringify(t.ops)}`);
    assert.equal(testId("motor-poles-busy"), null);
    assert.equal(testId("browser-poles"), null);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: gate busy for every try -> 'unknown' + the gate's message, not malformed / fallback (QA #60)", async () => {
    const t = await gatedHost("ok");
    const poll = t.holdGate("get erpm_m1");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    const budget = RPM_GATE_ATTEMPTS * RPM_GATE_DELAY_MS + 1500;
    assert.ok(await waitFor(() => testId("motor-poles-busy") !== null, budget), `exhausted state shown: ${poles()} refused=${t.refused.length}`);
    assert.equal(testId("motor-poles-busy"), GATE_BUSY_MESSAGE);
    assert.equal(poles(), "unknown");
    assert.equal(testId("browser-poles"), null, "not the older-FC fallback");
    assert.ok(isDisabled(input("motor_poles")) && isDisabled(button("Set on controller")));
    assert.equal(count(t.refused, "get motor_poles"), RPM_GATE_ATTEMPTS, "bounded: exactly RPM_GATE_ATTEMPTS tries");
    assert.ok(!t.ops.includes("get motor_poles"));
    poll.release(); await poll.done;
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: unmount stops the retries (nothing sent afterwards) (QA #60)", async () => {
    const t = await gatedHost("ok");
    const poll = t.holdGate("get erpm_m1");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => count(t.refused, "get motor_poles") >= 2, 1000));
    root.unmount();
    const tries = count(t.refused, "get motor_poles");
    await sleep(3 * RPM_GATE_DELAY_MS);
    poll.release(); await poll.done;
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.ok(count(t.refused, "get motor_poles") <= tries, `no retry after unmount: ${tries} -> ${count(t.refused, "get motor_poles")}`);
    assert.ok(!t.ops.includes("get motor_poles") && !t.ops.includes("rpm_filter"), `nothing sent after unmount: ${JSON.stringify(t.ops)}`);
    await t.mock.disconnect();
  });

  await test("real gate: disconnect stops the panel's retries; reconnect reads the FC (QA #60)", async () => {
    const t = await gatedHost("ok");
    const poll = t.holdGate("get erpm_m1");
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorPolesPanel host={t.host} fallback={fallbackEl} />));
    assert.ok(await waitFor(() => count(t.refused, "get motor_poles") >= 2, 1000));
    await t.mock.disconnect();
    const tries = count(t.refused, "get motor_poles");
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.ok(count(t.refused, "get motor_poles") <= tries, `no retry after disconnect: ${tries} -> ${count(t.refused, "get motor_poles")}`);
    poll.release(); await poll.done;
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.ok(!t.ops.includes("get motor_poles") && !t.ops.includes("rpm_filter"), `nothing sent after disconnect: ${JSON.stringify(t.ops)}`);
    assert.equal(poles(), "reading…", "no value, no busy line, no fallback while disconnected");
    assert.equal(testId("motor-poles-busy"), null);
    assert.equal(testId("browser-poles"), null);
    await t.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    assert.ok(await waitFor(() => poles() === "14", 1500), `re-read after reconnect: ${poles()} ops=${JSON.stringify(t.ops)}`);
    assert.deepEqual(rpmOps(t.ops), ["get motor_poles", "rpm_filter"], "only the reconnect's read reached the FC");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: Filters RPM reads busy for every try -> 'unknown' + the gate's message, not 'older firmware' (QA #60)", async () => {
    const t = await gatedHost("ok", { grabAfter: { op: "storage" } });
    const root = mountFilters(t.host);
    const budget = RPM_GATE_ATTEMPTS * RPM_GATE_DELAY_MS + 1500;
    assert.ok(await waitFor(() => testId("rpm-busy") !== null, budget), `busy line shown: refused=${t.refused.length} ${rpmSection()}`);
    assert.equal(testId("rpm-busy"), GATE_BUSY_MESSAGE);
    assert.ok(!/older firmware/.test(rpmSection()), `not reported as an older FC: ${rpmSection()}`);
    for (const k of rpmInputs) { assert.equal(input(k).value, "unknown", k); assert.ok(isDisabled(input(k)), `${k} read-only`); }
    assert.equal(count(t.refused, "get rpm_filter_harmonics"), RPM_GATE_ATTEMPTS, "bounded: exactly RPM_GATE_ATTEMPTS tries");
    assert.deepEqual(t.refused.filter((r) => r !== "get rpm_filter_harmonics"), [], "the other RPM reads are not tried once one stayed busy");
    assert.deepEqual(rpmOps(t.ops), [], "no RPM read reached the FC");
    t.grab.release(); await t.grab.done;
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: Filters rpm_filter report busy for every try -> busy line, not 'older firmware' (QA #60)", async () => {
    const t = await gatedHost("ok", { grabAfter: { op: "get motor_poles" } });
    const root = mountFilters(t.host);
    const budget = RPM_GATE_ATTEMPTS * RPM_GATE_DELAY_MS + 1500;
    assert.ok(await waitFor(() => testId("rpm-busy") !== null, budget), `busy line shown: refused=${t.refused.length} ${rpmSection()}`);
    assert.equal(testId("rpm-busy"), GATE_BUSY_MESSAGE);
    assert.ok(!/older firmware/.test(rpmSection()), `not reported as an older FC: ${rpmSection()}`);
    assert.equal(count(t.refused, "rpm_filter"), RPM_GATE_ATTEMPTS);
    assert.ok(!t.ops.includes("rpm_filter"), "the report never reached the FC");
    for (const k of rpmInputs) assert.ok(isDisabled(input(k)), `${k} read-only`);
    t.grab.release(); await t.grab.done;
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a real older FC behind a briefly busy gate still says 'older firmware', no busy line (QA #60)", async () => {
    const t = await gatedHost("old-fc", { grabAfter: { op: "storage", ms: 300 } });
    const root = mountFilters(t.host);
    assert.ok(await waitFor(() => t.ops.includes("rpm_filter"), 2500), `RPM reads finished: ${JSON.stringify(t.ops)}`);
    await sleep(50);
    assert.ok(t.refused.includes("get rpm_filter_harmonics"), `the RPM read met the busy gate: ${JSON.stringify(t.refused)}`);
    assert.ok(/This FC does not report the RPM filter \(older firmware\)/.test(rpmSection()), rpmSection());
    assert.equal(testId("rpm-busy"), null);
    for (const k of rpmInputs) { assert.equal(input(k).value, "unknown", k); assert.ok(isDisabled(input(k)), `${k} read-only`); }
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a real older FC whose RPM reads stay busy still says 'older firmware', no busy line (QA #60)", async () => {
    const t = await gatedHost("old-fc", { grabAfter: { op: "storage" } });
    const root = mountFilters(t.host);
    const budget = RPM_GATE_ATTEMPTS * RPM_GATE_DELAY_MS + 1500;
    assert.ok(await waitFor(() => count(t.refused, "get rpm_filter_harmonics") >= RPM_GATE_ATTEMPTS, budget), `RPM reads exhausted: ${t.refused.length}`);
    await sleep(100);
    assert.ok(/This FC does not report the RPM filter \(older firmware\)/.test(rpmSection()), `schema 8 from storage wins over the busy gate: ${rpmSection()}`);
    assert.equal(testId("rpm-busy"), null);
    for (const k of rpmInputs) { assert.equal(input(k).value, "unknown", k); assert.ok(isDisabled(input(k)), `${k} read-only`); }
    t.grab.release(); await t.grab.done;
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: Filters unmount stops the RPM retries (nothing sent afterwards) (QA #60)", async () => {
    const t = await gatedHost("ok", { grabAfter: { op: "storage" } });
    const root = mountFilters(t.host);
    assert.ok(await waitFor(() => count(t.refused, "get rpm_filter_harmonics") >= 2, 2500), `RPM read refused: ${JSON.stringify(t.refused)}`);
    root.unmount();
    const tries = t.refused.length;
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.ok(t.refused.length <= tries, `no retry after unmount: ${tries} -> ${t.refused.length}`);
    t.grab.release(); await t.grab.done;
    await sleep(3 * RPM_GATE_DELAY_MS);
    assert.deepEqual(rpmOps(t.ops), [], `nothing sent after unmount: ${JSON.stringify(t.ops)}`);
    await t.mock.disconnect();
  });

  console.log(`PASS RPM filter render: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 120000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exitCode = 1; });
