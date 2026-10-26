/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for per-tab defaults (D1): the real PID, Rates, Filters and
 * Setup pages in the #57 fake DOM (useHost stubbed by run-defaults-scoped.mjs)
 * over the REAL host adapter from createHost (its CommandGate and storage
 * tracking), the real BobFlightCliClient and the protocol MockSerial, which
 * resets the group's keys. A successful `defaults pid|rates|filters` reply is
 * the REAL host firmware's bytes (bobflight-firmware/build-contract/bobflight_host,
 * built by the CI contract step), checked byte-for-byte against MockSerial's
 * frame on every run; the malformed and refusal scenarios the host sim cannot
 * produce use the exact FW strings. `storage` is answered in the FW storage
 * report shape (schema 13, `accel_cal_saved:` just before `storage_end: 1`)
 * with the FW's dirty rule: RAM differs from what was last saved.
 * Asserts what a user sees (visible text only) and what went out on the wire.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { PidPage } from "../src/pages/PidPage";
import { RatesPage } from "../src/pages/RatesPage";
import { FiltersPage } from "../src/pages/FiltersPage";
import { SetupPage } from "../src/pages/SetupPage";
import { StoragePanel } from "../src/components/StoragePanel";
import { ACCEL_CAL_NOT_SAVED_NOTE } from "../src/components/AccelCalSavedNote";
import { GATE_BUSY_MESSAGE } from "../src/protocol/commandGate";
import { createHost } from "../src/protocol/createHost";
import type { BobFlightHost } from "../src/protocol/types";
import { DEFAULTS_BUSY_TEXT, DEFAULTS_UNSAVED_TEXT, DEFAULTS_CLEAN_TEXT, DEFAULTS_MAYBE_UNSAVED_TEXT, DEFAULTS_UNSUPPORTED_TEXT, DEFAULTS_GATE_WAIT_MS } from "../src/tuning/scopedDefaults";
import {
  DEFAULTS_GROUP_KEYS,
  DEFAULTS_RESULT_UNKNOWN,
  DEFAULTS_MOCK_ERROR_LINES,
  STORAGE_SCOPE_V13,
  defaultsKeyLines,
  type BobFlightCliClient,
  type DefaultsGroup,
  type DefaultsMockScenario,
  type MockSerial,
} from "@bobflight/protocol";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// ---- what a user sees -------------------------------------------------------
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  const cls = (e.getAttribute("class") ?? "").split(/\s+/);
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" ||
    e.style.visibility === "hidden" || e.style.opacity === "0" || cls.includes("sr-only") || cls.includes("visually-hidden");
}
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  const kids = n.tagName === "DETAILS" && !n.hasAttribute("open") ? n.childNodes.filter((c) => isEl(c) && c.tagName === "SUMMARY") : n.childNodes;
  return kids.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTestId = (id: string) => container.findAll((e) => e.getAttribute("data-testid") === id)[0] ?? null;
function shown(id: string): string | null {
  const el = byTestId(id);
  if (!el) return null;
  for (let p: FakeElement | null = el; p && p !== container; p = p.parentNode as FakeElement | null) if (isHidden(p)) return null;
  return visibleText(el);
}
const pageText = () => visibleText(container);
const alerts = () => container.findAll((e) => e.getAttribute("role") === "alert").map((e) => visibleText(e));
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
const buttons = () => container.findAll((e) => e.tagName === "BUTTON").map((e) => visibleText(e).trim());
function button(text: string): FakeElement {
  const b = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === text)[0];
  assert.ok(b, `button "${text}" rendered; buttons: ${buttons().join(" | ")}`);
  return b;
}
const findButton = (text: string) => container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === text)[0] ?? null;
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
function click(text: string) {
  const b = button(text);
  assert.ok(!isDisabled(b), `button "${text}" is enabled`);
  flushSync(() => reactProps(b).onClick({}));
}
function input(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `input #${id}`);
  return el;
}
const checked = (id: string) => (input(id) as unknown as { checked?: boolean }).checked;
function typeInto(id: string, value: string) {
  const el = input(id);
  flushSync(() => reactProps(el).onChange({ target: { value, checked: false } }));
}
/** Confirm dialog rows: [key, current value]. */
const confirmRows = () => (byTestId("defaults-confirm-keys")?.findAll((e) => e.tagName === "TR" && e.hasAttribute("data-key")) ?? [])
  .map((tr) => tr.childNodes.filter(isEl).map((td) => visibleText(td).trim()));
const dialog = () => container.findAll((e) => e.getAttribute("role") === "dialog")[0] ?? null;

// ---- rig: real createHost adapter + client + MockSerial ------------------------
interface Rig {
  host: BobFlightHost; client: BobFlightCliClient; port: MockSerial; root: Root;
  ctx: Record<string, unknown>;
  mark(): number; since(m: number): string[];
  holdGate(ms: number): Promise<unknown>;
  swallow: Set<string>;
  /** Tail line of the FW storage reply (null: line missing); `storageRaw` replaces the whole reply (real host bytes). */
  accel: { line: string | null; storageRaw: string | null; onSave?: () => void };
  /** host.storageActionPending() at the moment each `defaults <group>` hit the wire. */
  pendingAtDefaults: boolean[];
  /** Called for every line the UI writes (before the FC answers). */
  onWire?: (line: string) => void;
  /** Every gated adapter call is refused busy (nothing sent) until this time. */
  busyUntil: number;
  done(): Promise<void>;
}
const LABEL: Record<DefaultsGroup, string> = { pid: "PID", rates: "Rates", filters: "Filters" };

// ---- REAL host firmware replies --------------------------------------------------
const HOST_BIN = process.env.BOBFLIGHT_HOST_BIN ? process.env.BOBFLIGHT_HOST_BIN : fileURLToPath(new URL("../../../bobflight-firmware/build-contract/bobflight_host", import.meta.url));
const REAL_FRAME: Partial<Record<DefaultsGroup, string>> = {};
let realFramesServed = 0;
function loadRealFrames() {
  if (!existsSync(HOST_BIN)) {
    if (process.env.DEFAULTS_ALLOW_NO_HOST === "1") { console.log(`skip real host frames (no ${HOST_BIN}); MockSerial frames used`); return; }
    throw new Error(`real host firmware binary missing: ${HOST_BIN} (CI builds it in the contract step; DEFAULTS_ALLOW_NO_HOST=1 to skip locally)`);
  }
  for (const g of ["pid", "rates", "filters"] as const) {
    const r = spawnSync(HOST_BIN, [], { input: `set pid_roll_p 0.009\nset rate_max_roll 1200\nset gyro_lpf_hz 200\ndefaults ${g}\n`, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const m = new RegExp(`defaults_group: ${g}\\r\\n(?:defaults_key: [^\\r\\n]+\\r\\n)*defaults_end: ${g} \\d+\\r\\n`).exec(r.stdout);
    assert.ok(m, `real FW frame for ${g}`);
    REAL_FRAME[g] = m![0];
  }
}
function storageReply(dirty: boolean, accelLine: string | null = "accel_cal_saved: no"): string {
  return ["storage_api: 1", "backend: flash", "schema: 13", `state: ${dirty ? "dirty" : "saved"}`, `dirty: ${dirty ? 1 : 0}`, "generation: 2",
    "last_error: none", `scope: ${STORAGE_SCOPE_V13}`, "armed: 0", "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", ...(accelLine === null ? [] : [accelLine]), "storage_end: 1"]
    .map((l) => `${l}\r\n`).join("");
}
async function rig(): Promise<Rig> {
  const host = createHost("mock");
  await host.connect({ path: "mock://bobflight", baudRate: 115200, transport: "mock" });
  await sleep(10);
  const client = (host as unknown as { getClient(): BobFlightCliClient }).getClient();
  const port = (client as unknown as { port: MockSerial }).port;
  // FW rule: dirty = RAM differs from the last save (boot = saved defaults).
  let savedSnap = JSON.stringify(port.getSettingsSnapshot());
  const fcDirty = () => JSON.stringify(port.getSettingsSnapshot()) !== savedSnap;
  const swallow = new Set<string>();
  const accel: Rig["accel"] = { line: "accel_cal_saved: no", storageRaw: null };
  const pendingAtDefaults: boolean[] = [];
  // FW `storage` report (MockSerial has none); a successful scoped defaults reply is the real FW's bytes.
  const rigRef: { r?: Rig } = {};
  const write = port.write.bind(port);
  (port as unknown as { write: (d: string | Buffer) => boolean }).write = (data) => {
    const line = String(data).trim();
    rigRef.r?.onWire?.(line);
    if (swallow.has(line)) return true; // an FC that never answers this line
    if (line === "storage") { const d = fcDirty(); const reply = accel.storageRaw ?? storageReply(d, accel.line); setTimeout(() => port.emit("data", Buffer.from(reply)), 1); return true; }
    if (/^defaults (pid|rates|filters)$/.test(line)) pendingAtDefaults.push(host.storageActionPending!());
    const g = /^defaults (pid|rates|filters)$/.exec(line)?.[1] as DefaultsGroup | undefined;
    if (g && port.defaultsScenario === "ok" && REAL_FRAME[g]) {
      const emit = port.emit.bind(port); let mock = "";
      (port as unknown as { emit: (ev: string, b: Buffer) => boolean }).emit = (ev, b) => { if (ev === "data") { mock += b.toString(); return true; } return emit(ev, b); };
      try { write(data); } finally { (port as unknown as { emit: typeof emit }).emit = emit; }
      assert.equal(mock, REAL_FRAME[g], `MockSerial frame for ${g} == real FW bytes`);
      realFramesServed++;
      setTimeout(() => port.emit("data", Buffer.from(REAL_FRAME[g]!)), 1);
      return true;
    }
    // FW flash-save reply shape (MockSerial only acks "saved", which is not a verified flash save).
    if (line === "save") { accel.onSave?.(); savedSnap = JSON.stringify(port.getSettingsSnapshot()); setTimeout(() => port.emit("data", Buffer.from("saved: flash verified\r\n")), 1); return true; }
    return write(data);
  };
  client.clearSentCommands();
  const ctx: Record<string, unknown> = {
    host, connectionStatus: "connected", postFlashGate: false, version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {},
  };
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  const root = createRoot(container as never);
  const gate = (host as unknown as { commands: { run<T>(w: () => Promise<T>, ...a: unknown[]): Promise<T> } }).commands;
  const run = gate.run.bind(gate);
  gate.run = (w, ...a) => (Date.now() < (rigRef.r?.busyUntil ?? 0) ? Promise.reject(new Error(GATE_BUSY_MESSAGE)) : run(w, ...a)) as never;
  return rigRef.r = {
    busyUntil: 0,
    host, client, port, root, ctx, swallow, accel, pendingAtDefaults,
    mark: () => client.getSentCommands().length,
    since: (m) => client.getSentCommands().slice(m),
    holdGate: (ms) => run(() => sleep(ms)),
    done: async () => { flushSync(() => root.unmount()); await host.disconnect(); },
  };
}
function render(r: Rig, page: "pid" | "rates" | "filters" | "setup" | "storage") {
  const el = page === "pid" ? <PidPage /> : page === "rates" ? <RatesPage /> : page === "filters" ? <FiltersPage /> : page === "storage" ? <StoragePanel /> : <SetupPage />;
  flushSync(() => r.root.render(el));
}
/** Opens the page and waits until it shows FC values. */
async function openTab(r: Rig, g: DefaultsGroup) {
  render(r, g);
  const probe = g === "pid" ? "pid_roll_p" : g === "rates" ? "rate_max_roll" : "gyro_lpf_hz";
  assert.ok(await waitFor(() => { const b = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === "Defaults…")[0]; return !!b && !isDisabled(b) && input(probe).value !== "0" && input(probe).value !== ""; }), `${g} tab loaded; text: ${pageText().slice(0, 300)}`);
  if (g === "filters") assert.ok(await waitFor(() => !/Connecting/.test(pageText())));
  await quiet(r);
  assert.ok(await waitFor(() => { const b = findButton("Defaults…"); return !!b && !isDisabled(b); }), `${g}: Defaults enabled after load; alerts: ${alerts().join(" | ")}`);
}
/** Waits until the page has sent nothing for 300 ms (its load finished). */
async function quiet(r: Rig) {
  let n = r.mark(), still = Date.now();
  const end = Date.now() + 8000;
  while (Date.now() < end) { await sleep(25); const k = r.mark(); if (k !== n) { n = k; still = Date.now(); } else if (Date.now() - still >= 300) return; }
  assert.fail("page never went quiet");
}
/** Clicks Defaults…, waits for the confirm dialog (current values read from the FC). */
async function openDialog() {
  click("Defaults…");
  assert.ok(await waitFor(() => !!dialog()), `confirm dialog opened; alerts: ${alerts().join(" | ")}`);
}
async function confirm(g: DefaultsGroup) {
  click(`Restore ${LABEL[g]} defaults`);
  assert.ok(await waitFor(() => { const b = findButton("Defaults…"); return !dialog() && !!b && !isDisabled(b); }, 8000), `run finished; buttons: ${buttons().join(" | ")}`);
  await sleep(80);
}
/** Changes the FC value of one key per group (so a reset is visible). */
async function dirtyFc(r: Rig) {
  await r.host.setSetting("pid_roll_p", "0.009");
  await r.host.setSetting("airmode", "1");
  await r.host.setSetting("rate_max_roll", "1200");
  await r.host.setSetting("rate_expo_yaw", "0.5");
  await r.host.setSetting("gyro_lpf_hz", "200");
  await r.host.setSetting("gyro_notch1_cutoff_hz", "150");
  await r.host.setSetting("gyro_notch1_hz", "200");
  await r.host.setSetting("rpm_filter_harmonics", "2");
  await r.host.setSetting("motor_poles", "12");
  r.client.clearSentCommands();
}
const CHANGED: Record<DefaultsGroup, [string, string, string][]> = {
  // [key, value before, default after]
  pid: [["pid_roll_p", "0.009", "0.002"], ["airmode", "1", "0"]],
  rates: [["rate_max_roll", "1200", "800"], ["rate_expo_yaw", "0.5", "0.3"]],
  filters: [["gyro_lpf_hz", "200", "320"], ["gyro_notch1_hz", "200", "0"], ["rpm_filter_harmonics", "2", "0"]],
};

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
const isSave = (c: string) => c === "save";

async function main() {
  loadRealFrames();
  for (const g of ["pid", "rates", "filters"] as const) {
    await test(`${LABEL[g]} tab: confirm dialog lists the ${DEFAULTS_GROUP_KEYS[g].length} ${g} keys with current FC values, the not-touched note and nothing-saved note`, async () => {
      const r = await rig(); await dirtyFc(r); await openTab(r, g);
      const m = r.mark();
      await openDialog();
      const rows = confirmRows();
      assert.deepEqual(rows.map((x) => x[0]), [...DEFAULTS_GROUP_KEYS[g]], "every key of this tab, and only those");
      for (const [k, before] of CHANGED[g]) assert.deepEqual(rows.find((x) => x[0] === k), [k, before], `${k} shows its CURRENT FC value`);
      assert.ok(rows.every((x) => x[1] !== "" && x[1] !== "unknown"), JSON.stringify(rows));
      assert.deepEqual(r.since(m), DEFAULTS_GROUP_KEYS[g].map((k) => `get ${k}`), "the dialog read exactly this tab's keys, nothing else was sent");
      const note = shown("defaults-not-touched") ?? "";
      for (const w of ["board alignment", "motor direction", "loop rate", "accelerometer", "calibration"]) assert.ok(note.includes(w), `not-touched note names ${w}: ${note}`);
      assert.match(shown("defaults-not-saved") ?? "", /Nothing is saved until you press Save/);
      assert.match(visibleText(dialog()!), new RegExp(`defaults ${g}`), "dialog names the exact command");
      // Cancel sends nothing.
      const m2 = r.mark(); click("Cancel"); await sleep(400);
      assert.equal(dialog(), null); assert.deepEqual(r.since(m2), [], "Cancel sent nothing");
      await r.done();
    });

    await test(`${LABEL[g]} tab: Restore sends exactly "defaults ${g}", shows the defaults_key lines verbatim, re-reads the tab and the FC storage dirty flag, never sends save`, async () => {
      const r = await rig(); await dirtyFc(r); await openTab(r, g);
      if (g === "pid") assert.equal(checked("airmode"), true, "AirMode on before the reset (FC airmode=1)");
      await openDialog();
      const m = r.mark();
      let pendingSeen = false;
      const off = r.host.onStorageActivity!(() => { if (r.host.storageActionPending!()) pendingSeen = true; });
      await confirm(g);
      off();
      const sent = r.since(m);
      assert.deepEqual(sent.filter((c) => c.startsWith("defaults")), [`defaults ${g}`], `one defaults command, this tab's group: ${JSON.stringify(sent)}`);
      assert.ok(!sent.some(isSave), `no save: ${JSON.stringify(sent)}`);
      assert.ok(pendingSeen, "tracked host-wide as a settings storage action");
      assert.deepEqual(r.pendingAtDefaults, [true], "the defaults command itself ran as a tracked storage action");
      const after = sent.slice(sent.indexOf(`defaults ${g}`) + 1);
      for (const k of DEFAULTS_GROUP_KEYS[g]) assert.ok(after.includes(`get ${k}`), `re-read ${k} after the reset: ${JSON.stringify(after)}`);
      assert.ok(after.includes("storage"), `the FC storage report read after the reset: ${JSON.stringify(after)}`);
      if (REAL_FRAME[g]) assert.equal(shown("defaults-key-lines"), REAL_FRAME[g]!.split("\r\n").filter((l) => l.startsWith("defaults_key: ")).join("\n"), "the real FW defaults_key lines, verbatim");
      // Verbatim FW lines, in FW order.
      assert.equal(shown("defaults-key-lines"), defaultsKeyLines(g).join("\n"));
      assert.match(pageText(), new RegExp(`${LABEL[g]} defaults restored on the controller \\(${DEFAULTS_GROUP_KEYS[g].length} settings\\)`));
      assert.equal(shown("defaults-unsaved"), DEFAULTS_UNSAVED_TEXT);
      assert.ok(!pageText().includes(DEFAULTS_RESULT_UNKNOWN));
      // The inputs show what the FC re-read.
      for (const [k, , def] of CHANGED[g]) {
        const want = k.startsWith("rate_expo_") ? String(Number(def) * 100) : def;
        if (k === "airmode") { assert.ok(await waitFor(() => checked("airmode") === false), "AirMode checkbox re-read to off"); continue; }
        if (k === "gyro_notch1_hz" || k === "rpm_filter_harmonics") continue; // shown in the notch/RPM tables
        assert.ok(await waitFor(() => input(k).value === want), `${k} input re-read to ${want}, got ${input(k).value}`);
      }
      // Other groups untouched on the FC.
      const others = (["pid", "rates", "filters"] as const).filter((x) => x !== g);
      for (const o of others) for (const [k, before] of CHANGED[o]) assert.equal((await r.host.getSetting(k as never)).value, before, `${k} untouched by defaults ${g}`);
      assert.equal((await r.host.getSetting("motor_poles")).value, "12", "motor_poles never reset");
      await sleep(600);
      assert.ok(!r.client.getSentCommands().some(isSave), "still no save after everything settled");
      await r.done();
    });
  }

  await test("every defaults_error line is shown verbatim (prefix match, unknown future code too); nothing re-read as success, no unsaved claim", async () => {
    for (const [g, s] of [["pid", "armed"], ["rates", "bench_active"], ["filters", "calibration_active"], ["pid", "unknown_group"], ["rates", "group_required"], ["filters", "future_error"], ["pid", "future_error"], ["rates", "blackbox_refused"], ["filters", "blackbox_refused"]] as [DefaultsGroup, DefaultsMockScenario][]) {
      const r = await rig(); r.port.defaultsScenario = s; await openTab(r, g);
      await openDialog(); const m = r.mark(); await confirm(g);
      const line = DEFAULTS_MOCK_ERROR_LINES[s];
      assert.equal(shown("defaults-fc-line"), line, `${g}/${s}: the FC line verbatim`);
      assert.ok(alerts().includes(line), `${g}/${s}: as an alert`);
      assert.ok(!pageText().includes(DEFAULTS_RESULT_UNKNOWN) && shown("defaults-key-lines") === null && shown("defaults-unsaved") === null, `${g}/${s}: no success/unknown claim`);
      assert.ok(!/defaults restored/.test(pageText()), `${g}/${s}: no restored text`);
      assert.deepEqual(r.since(m).filter((c) => c.startsWith("defaults") || isSave(c)), [`defaults ${g}`]);
      await r.done();
    }
  });

  for (const g of ["pid", "rates", "filters"] as const) {
    await test(`${LABEL[g]} tab: missing defaults_end, count mismatch and group mismatch -> "${DEFAULTS_RESULT_UNKNOWN}", detail visible, tab re-read, never success`, async () => {
      for (const [s, why] of [["missing_end", /defaults_end line missing/], ["count_mismatch", /count mismatch/], ["group_mismatch", /group mismatch/]] as [DefaultsMockScenario, RegExp][]) {
        const r = await rig(); await dirtyFc(r); r.port.defaultsScenario = s; await openTab(r, g);
        await openDialog(); const m = r.mark(); await confirm(g);
        const unk = shown("defaults-unknown") ?? "";
        assert.ok(unk.includes(DEFAULTS_RESULT_UNKNOWN), `${g}/${s}: unknown shown: ${pageText().slice(-600)}`);
        assert.match(shown("defaults-unknown-detail") ?? "", why);
        assert.ok(!/defaults restored on the controller/.test(pageText()), `${g}/${s}: no success text`);
        assert.equal(shown("defaults-unsaved"), DEFAULTS_MAYBE_UNSAVED_TEXT, `${g}/${s}: storage may be dirty (not claimed either way)`);
        const sent = r.since(m);
        assert.ok(DEFAULTS_GROUP_KEYS[g].every((k) => sent.slice(sent.indexOf(`defaults ${g}`)).includes(`get ${k}`)), `${g}/${s}: re-read after unknown`);
        assert.ok(!sent.some(isSave));
        await r.done();
      }
    });
  }

  await test("FC never answers (timeout) -> unknown with the transport detail, tab re-read; older FC (unknown command) -> verbatim line, nothing changed", async () => {
    let r = await rig(); await openTab(r, "pid"); r.swallow.add("defaults pid");
    await openDialog(); await confirm("pid");
    assert.ok((shown("defaults-unknown") ?? "").includes(DEFAULTS_RESULT_UNKNOWN));
    assert.match(shown("defaults-unknown-detail") ?? "", /timed out/);
    await r.done();
    r = await rig(); r.port.defaultsScenario = "unsupported"; await openTab(r, "rates");
    await openDialog(); await confirm("rates");
    assert.equal(shown("defaults-fc-line"), "unknown — try help");
    assert.ok(pageText().includes(DEFAULTS_UNSUPPORTED_TEXT));
    assert.equal(shown("defaults-unsaved"), null);
    await r.done();
  });

  await test("busy connection: the gate's refusal is retried briefly, then plain text; nothing was sent (dialog read and the run)", async () => {
    const r = await rig(); await openTab(r, "pid");
    let m = r.mark();
    const held = r.holdGate(DEFAULTS_GATE_WAIT_MS + 1500);
    click("Defaults…");
    assert.ok(await waitFor(() => pageText().includes(DEFAULTS_BUSY_TEXT), DEFAULTS_GATE_WAIT_MS + 1000), "busy text while opening");
    assert.equal(dialog(), null, "no dialog with unknown values");
    assert.deepEqual(r.since(m), [], "nothing sent");
    await held;
    // Busy only during the run itself.
    await openDialog(); m = r.mark();
    const held2 = r.holdGate(DEFAULTS_GATE_WAIT_MS + 1500);
    click("Restore PID defaults");
    assert.ok(await waitFor(() => pageText().includes(DEFAULTS_BUSY_TEXT), DEFAULTS_GATE_WAIT_MS + 1000), "busy text on the run");
    assert.ok(!r.since(m).includes("defaults pid"), "defaults never sent while the gate stayed busy");
    assert.ok(!pageText().includes(DEFAULTS_RESULT_UNKNOWN), "busy is not 'unknown': nothing reached the FC");
    await held2;
    // A short hold is waited out and the command goes through once.
    await sleep(100); await openDialog(); m = r.mark();
    const held3 = r.holdGate(400);
    click("Restore PID defaults");
    assert.ok(await waitFor(() => shown("defaults-key-lines") !== null, 4000), "went through after the short hold");
    assert.equal(r.since(m).filter((c) => c === "defaults pid").length, 1, "sent exactly once");
    await held3; await r.done();
  });

  await test("Rates tab: local edits are warned about in the dialog and replaced by the re-read FC values; a verified Save clears the unsaved note", async () => {
    const r = await rig(); await r.host.setSetting("pid_roll_p", "0.009"); await openTab(r, "rates");
    typeInto("rate_max_pitch", "1500");
    await openDialog();
    assert.match(visibleText(dialog()!), /Your unsaved edits on this tab will be replaced/);
    assert.deepEqual(confirmRows().find((x) => x[0] === "rate_max_pitch"), ["rate_max_pitch", "800"], "dialog shows the FC value, not the draft");
    await confirm("rates");
    assert.ok(await waitFor(() => input("rate_max_pitch").value === "800"), "draft replaced by FC value");
    assert.equal(shown("defaults-unsaved"), DEFAULTS_UNSAVED_TEXT);
    // Only the user's own Save stores them; once flash-verified the note goes away.
    await quiet(r);
    const m = r.mark();
    click("Save to controller");
    assert.ok(await waitFor(() => pageText().includes("Saved to controller flash and read back.")), `saved: ${alerts().join(" | ")}`);
    assert.equal(r.since(m).filter(isSave).length, 1, "exactly the one Save the user pressed");
    assert.equal(shown("defaults-unsaved"), null, "unsaved note cleared after the verified Save");
    await r.done();
  });

  await test("defaults equal to the saved values: the FC storage report is clean, so the UI says nothing to save (FW dirty = RAM differs from flash); no save sent", async () => {
    const r = await rig(); await r.host.setSetting("rate_max_roll", "1200"); await openTab(r, "rates");
    await openDialog(); const m = r.mark(); await confirm("rates");
    assert.ok(shown("defaults-key-lines") !== null);
    assert.ok(await waitFor(() => shown("defaults-unsaved") === DEFAULTS_CLEAN_TEXT), `clean: ${shown("defaults-unsaved")}`);
    const sent = r.since(m); assert.ok(sent.includes("storage") && !sent.some(isSave), JSON.stringify(sent));
    // Storage unreadable after a successful reset -> "may have unsaved changes", never a clean claim.
    await r.host.setSetting("pid_roll_p", "0.009"); await openTab(r, "pid"); r.swallow.add("storage");
    await openDialog(); await confirm("pid");
    assert.ok(await waitFor(() => shown("defaults-unsaved") === DEFAULTS_MAYBE_UNSAVED_TEXT, 8000), `maybe: ${shown("defaults-unsaved")}`);
    await r.done();
  });

  await test("StoragePanel: accel_cal_saved shown verbatim next to Save: yes, no (+ recalibrate note), missing -> unknown; real host storage reply; a save that drops it shows no", async () => {
    const accelText = () => shown("accel-cal-saved-line");
    for (const [line, want, note] of [["accel_cal_saved: yes", "accel_cal_saved: yes", false], ["accel_cal_saved: no", "accel_cal_saved: no", true], [null, "accel_cal_saved: unknown", false]] as [string | null, string, boolean][]) {
      const r = await rig(); r.accel.line = line; render(r, "storage");
      assert.ok(await waitFor(() => accelText() !== null), `panel loaded: ${pageText().slice(0, 300)}`);
      assert.equal(accelText(), want, `${line}: shown verbatim`);
      assert.equal(shown("accel-cal-not-saved"), note ? ACCEL_CAL_NOT_SAVED_NOTE : null, `${line}: recalibrate note only for no`);
      if (line === null) assert.match(shown("accel-cal-saved") ?? "", /line missing from the storage reply/);
      await r.done();
    }
    if (REAL_FRAME.pid) {
      const out = spawnSync(HOST_BIN, [], { input: "set align_board_roll 90\nsave\nstorage\n", encoding: "utf8" }).stdout;
      const real = /storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/.exec(out)![0];
      const r = await rig(); r.accel.storageRaw = real; render(r, "storage");
      assert.ok(await waitFor(() => accelText() !== null), `real host reply rendered: ${pageText().slice(0, 300)}`);
      assert.equal(accelText(), "accel_cal_saved: no", "real host bytes, verbatim");
      assert.equal(shown("accel-cal-not-saved"), ACCEL_CAL_NOT_SAVED_NOTE);
      assert.match(pageText(), /Host simulation/);
      await r.done();
    }
    // Calibrated FC; a save (e.g. after a board alignment change) drops it: the save reply says nothing, the storage line does.
    const r = await rig(); r.accel.line = "accel_cal_saved: yes"; render(r, "storage");
    assert.ok(await waitFor(() => accelText() === "accel_cal_saved: yes"));
    await r.host.setSetting("pid_roll_p", "0.009");
    click("Refresh storage"); await sleep(300);
    r.accel.onSave = () => { r.accel.line = "accel_cal_saved: no"; };
    const btn = () => findButton("Save to controller");
    assert.ok(await waitFor(() => !!btn() && !isDisabled(btn()!)), `Save enabled: ${pageText().slice(0, 400)}`);
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(pageText())), `saved: ${alerts().join(" | ")}`);
    assert.equal(accelText(), "accel_cal_saved: no", "post-save storage line shown verbatim");
    assert.equal(shown("accel-cal-not-saved"), ACCEL_CAL_NOT_SAVED_NOTE);
    await r.done();
  });

  const noMock = () => !/mockSettingsApi|demo memory|Local demo/i.test(pageText());
  await test("PID: tab load while the gate stays busy (4 s) -> read error + Read again, Save and Defaults disabled, never demo memory; Read again recovers", async () => {
    const r = await rig(); const held = r.holdGate(4000); render(r, "pid");
    assert.ok(await waitFor(() => shown("pid-read-error") !== null, 6000), `read error shown: ${pageText().slice(0, 400)}`);
    assert.match(shown("pid-read-error")!, new RegExp(GATE_BUSY_MESSAGE.replace(/[;()]/g, ".")));
    assert.ok(noMock(), `no demo fallback: ${pageText().slice(0, 400)}`);
    assert.ok(isDisabled(findButton("Save")!), "Save disabled"); assert.ok(isDisabled(findButton("Defaults…")!), "Defaults disabled");
    await held; click("Read again");
    assert.ok(await waitFor(() => !isDisabled(findButton("Defaults…")!) && !isDisabled(findButton("Save")!)), "real read enables Defaults and Save");
    assert.equal(shown("pid-read-error"), null); assert.ok(noMock());
    await r.done();
  });

  await test("PID: the re-read right after `defaults pid` hits a busy gate beyond the retry -> read error + Read again, no demo memory, Defaults/Save disabled; Read again recovers", async () => {
    const r = await rig(); await r.host.setSetting("pid_roll_p", "0.009"); await openTab(r, "pid");
    await openDialog();
    r.onWire = (l) => { if (l === "defaults pid") { r.busyUntil = Date.now() + 3500; r.onWire = undefined; } };
    click("Restore PID defaults");
    assert.ok(await waitFor(() => shown("pid-read-error") !== null, 8000), `read error after defaults: ${pageText().slice(-500)}`);
    assert.ok(await waitFor(() => !!findButton("Defaults…"), 8000), "run settled");
    assert.ok(shown("defaults-key-lines") !== null, "the FC reply itself is still shown");
    assert.ok(noMock(), "no demo fallback");
    assert.ok(isDisabled(findButton("Save")!)); assert.ok(isDisabled(findButton("Defaults…")!));
    await sleep(Math.max(0, r.busyUntil - Date.now()) + 50); click("Read again");
    assert.ok(await waitFor(() => input("pid_roll_p").value === "0.002" && !isDisabled(findButton("Save")!)), "re-read shows FC default");
    await r.done();
  });

  await test("Filters: tab load with the gate held 5 s (beyond its retry) -> settings busy shown, Read again, no demo memory, Save/Defaults disabled (U22)", async () => {
    const r = await rig(); const held = r.holdGate(5000); render(r, "filters");
    await sleep(4300);
    assert.ok(noMock(), `no demo fallback: ${pageText().slice(0, 500)}`);
    assert.equal(shown("settings-busy"), GATE_BUSY_MESSAGE, "the gate's busy message");
    assert.ok(shown("filters-read-error") !== null && !!findButton("Read again"), "Read again offered");
    assert.ok(isDisabled(findButton("Save")!)); assert.ok(isDisabled(findButton("Defaults…")!));
    await held; click("Read again");
    assert.ok(await waitFor(() => !isDisabled(findButton("Defaults…")!) && input("gyro_lpf_hz").value === "320", 8000), "loads after Read again");
    assert.ok(noMock());
    await r.done();
  });

  await test("double confirm (two clicks before React re-renders) sends exactly one `defaults pid`", async () => {
    const r = await rig(); await openTab(r, "pid"); await openDialog();
    const b = button("Restore PID defaults"); const m = r.mark();
    flushSync(() => { reactProps(b).onClick({}); reactProps(b).onClick({}); });
    assert.ok(await waitFor(() => shown("defaults-key-lines") !== null, 8000)); await quiet(r);
    assert.equal(r.since(m).filter((c) => c === "defaults pid").length, 1);
    await r.done();
  });

  for (const g of ["pid", "rates", "filters"] as const) {
    await test(`${LABEL[g]} tab: accel_cal_saved shown next to Save (verbatim no + note; exact yes after a Save; repeated -> repeated line)`, async () => {
      let r = await rig(); await r.host.setSetting("pid_roll_p", "0.009"); await openTab(r, g);
      assert.ok(await waitFor(() => shown("accel-cal-saved-line") === "accel_cal_saved: no"), `${g}: ${shown("accel-cal-saved-line")}`);
      assert.equal(shown("accel-cal-not-saved"), ACCEL_CAL_NOT_SAVED_NOTE);
      await r.done();
      r = await rig(); r.accel.line = "accel_cal_saved: yes"; await openTab(r, g);
      assert.ok(await waitFor(() => shown("accel-cal-saved-line") === "accel_cal_saved: yes"));
      assert.equal(shown("accel-cal-not-saved"), null);
      await r.done();
      if (g === "pid") {
        r = await rig(); r.accel.storageRaw = storageReply(false, "accel_cal_saved: yes\r\naccel_cal_saved: yes"); render(r, "pid");
        assert.ok(await waitFor(() => /repeated line/.test(shown("accel-cal-saved") ?? "")), `repeated: ${shown("accel-cal-saved")}`);
        assert.equal(shown("accel-cal-saved-line"), "accel_cal_saved: unknown");
        await r.done();
      }
    });
  }

  await test("accel_cal_saved B1: only byte-exact yes/no shown bare; trailing space, tab, ZWSP, Cyrillic е -> unknown (FC sent: \"...\"), no note; a line after storage_end does not count", async () => {
    for (const line of ["accel_cal_saved: yes ", "accel_cal_saved: yes\t", "accel_cal_saved: y\u200bes", "accel_cal_saved: y\u0435s", "accel_cal_saved: n\u043e"]) {
      const r = await rig(); r.accel.line = line; render(r, "storage");
      assert.ok(await waitFor(() => shown("accel-cal-saved-line") !== null), pageText().slice(0, 300));
      assert.equal(shown("accel-cal-saved-line"), `unknown (FC sent: ${JSON.stringify(line)})`, JSON.stringify(line));
      assert.ok(!shown("accel-cal-saved-line")!.startsWith("accel_cal_saved: yes"), "never looks like a yes");
      assert.equal(shown("accel-cal-not-saved"), null);
      await r.done();
    }
    for (const line of ["accel_cal_saved: yes", "accel_cal_saved: no"]) {
      const r = await rig(); r.accel.line = line; render(r, "storage");
      assert.ok(await waitFor(() => shown("accel-cal-saved-line") === line), `${line}: ${shown("accel-cal-saved-line")}`);
      await r.done();
    }
    const r = await rig(); r.accel.storageRaw = storageReply(false, null) + "accel_cal_saved: yes\r\n"; render(r, "pid");
    assert.ok(await waitFor(() => shown("accel-cal-saved-line") !== null), pageText().slice(0, 300));
    assert.equal(shown("accel-cal-saved-line"), "accel_cal_saved: unknown", "after storage_end ignored");
    assert.match(shown("accel-cal-saved")!, /line missing/);
    await r.done();
  });

  await test("Setup tab: the full Reset/Restore defaults button is gone, copy points to the per-tab Defaults, bare `defaults` never sent", async () => {
    const r = await rig(); render(r, "setup"); await sleep(600);
    const b = buttons();
    assert.ok(!b.some((t) => /restore defaults|reset/i.test(t)), `no reset button: ${b.join(" | ")}`);
    assert.ok(!/restoreDefaults|all 12/.test(pageText()), "old copy gone");
    const note = shown("setup-defaults-note") ?? "";
    assert.match(note, /PID, Rates or\s+Filters tab/); assert.match(note, /nothing is saved\s+until you press Save/);
    assert.match(note, /There is no full reset on this page/);
    assert.ok(!r.client.getSentCommands().some((c) => c.startsWith("defaults")), "Setup sends no defaults command");
    await r.done();
  });

  await test("bare `defaults` (old full reset) is refused by the FC shape: group_required verbatim; the UI host never sends it from any tab", async () => {
    const r = await rig();
    await assert.rejects(r.host.restoreDefaults(), (e: Error) => e.message === DEFAULTS_MOCK_ERROR_LINES.group_required);
    for (const g of ["pid", "rates", "filters"] as const) { await openTab(r, g); await openDialog(); await confirm(g); }
    const sent = r.client.getSentCommands().filter((c) => c.startsWith("defaults"));
    assert.deepEqual(sent, ["defaults", "defaults pid", "defaults rates", "defaults filters"]);
    await r.done();
  });

  if (existsSync(HOST_BIN)) assert.ok(realFramesServed >= 3, `real FW frames served: ${realFramesServed}`);
  console.log(`defaults-scoped render tests: ${passed} passed (${realFramesServed} successful defaults replies were real host FW bytes)`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
