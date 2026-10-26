/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for per-tab defaults (D1): the real PID, Rates, Filters and
 * Setup pages in the #57 fake DOM (useHost stubbed by run-defaults-scoped.mjs)
 * over the REAL host adapter from createHost (its CommandGate and storage
 * tracking), the real BobFlightCliClient and the protocol MockSerial, which
 * answers `defaults pid|rates|filters` in the frozen FW shape (fixture replies
 * until the FW branch lands). `storage` is answered with the FW storage
 * report shape (schema 13). Asserts what a user sees (visible text only) and
 * what went out on the wire.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { PidPage } from "../src/pages/PidPage";
import { RatesPage } from "../src/pages/RatesPage";
import { FiltersPage } from "../src/pages/FiltersPage";
import { SetupPage } from "../src/pages/SetupPage";
import { createHost } from "../src/protocol/createHost";
import type { BobFlightHost } from "../src/protocol/types";
import { DEFAULTS_BUSY_TEXT, DEFAULTS_UNSAVED_TEXT, DEFAULTS_MAYBE_UNSAVED_TEXT, DEFAULTS_UNSUPPORTED_TEXT, DEFAULTS_GATE_WAIT_MS } from "../src/tuning/scopedDefaults";
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
  storageState: { dirty: boolean }; swallow: Set<string>;
  done(): Promise<void>;
}
const LABEL: Record<DefaultsGroup, string> = { pid: "PID", rates: "Rates", filters: "Filters" };
function storageReply(dirty: boolean): string {
  return ["storage_api: 1", "backend: flash", "schema: 13", `state: ${dirty ? "dirty" : "saved"}`, `dirty: ${dirty ? 1 : 0}`, "generation: 2",
    "last_error: none", `scope: ${STORAGE_SCOPE_V13}`, "armed: 0", "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", "storage_end: 1"]
    .map((l) => `${l}\r\n`).join("");
}
async function rig(): Promise<Rig> {
  const host = createHost("mock");
  await host.connect({ path: "mock://bobflight", baudRate: 115200, transport: "mock" });
  await sleep(10);
  const client = (host as unknown as { getClient(): BobFlightCliClient }).getClient();
  const port = (client as unknown as { port: MockSerial }).port;
  const storageState = { dirty: false };
  const swallow = new Set<string>();
  // FW `storage` report (MockSerial has none): dirty after an applied set/defaults, clean after save.
  const write = port.write.bind(port);
  (port as unknown as { write: (d: string | Buffer) => boolean }).write = (data) => {
    const line = String(data).trim();
    if (swallow.has(line)) return true; // an FC that never answers this line
    if (line === "storage") { setTimeout(() => port.emit("data", Buffer.from(storageReply(storageState.dirty))), 1); return true; }
    if (line.startsWith("set ") || (/^defaults (pid|rates|filters)$/.test(line) && !(port.defaultsScenario in DEFAULTS_MOCK_ERROR_LINES) && port.defaultsScenario !== "unsupported")) storageState.dirty = true;
    // FW flash-save reply shape (MockSerial only acks "saved", which is not a verified flash save).
    if (line === "save") { storageState.dirty = false; setTimeout(() => port.emit("data", Buffer.from("saved: flash verified\r\n")), 1); return true; }
    return write(data);
  };
  client.clearSentCommands();
  const ctx: Record<string, unknown> = {
    host, connectionStatus: "connected", postFlashGate: false, version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {},
  };
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  const root = createRoot(container as never);
  const gate = (host as unknown as { commands: { run<T>(w: () => Promise<T>): Promise<T> } }).commands;
  return {
    host, client, port, root, ctx, storageState, swallow,
    mark: () => client.getSentCommands().length,
    since: (m) => client.getSentCommands().slice(m),
    holdGate: (ms) => gate.run(() => sleep(ms)),
    done: async () => { flushSync(() => root.unmount()); await host.disconnect(); },
  };
}
function render(r: Rig, page: "pid" | "rates" | "filters" | "setup") {
  const el = page === "pid" ? <PidPage /> : page === "rates" ? <RatesPage /> : page === "filters" ? <FiltersPage /> : <SetupPage />;
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

    await test(`${LABEL[g]} tab: Restore sends exactly "defaults ${g}", shows the defaults_key lines verbatim, re-reads the tab, marks unsaved, never sends save`, async () => {
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
      const after = sent.slice(sent.indexOf(`defaults ${g}`) + 1);
      for (const k of DEFAULTS_GROUP_KEYS[g]) assert.ok(after.includes(`get ${k}`), `re-read ${k} after the reset: ${JSON.stringify(after)}`);
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
    for (const [g, s] of [["pid", "armed"], ["rates", "bench_active"], ["filters", "calibration_active"], ["pid", "unknown_group"], ["rates", "group_required"], ["filters", "future_error"], ["pid", "future_error"]] as [DefaultsGroup, DefaultsMockScenario][]) {
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
    const r = await rig(); await openTab(r, "rates");
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

  console.log(`defaults-scoped render tests: ${passed} passed`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
