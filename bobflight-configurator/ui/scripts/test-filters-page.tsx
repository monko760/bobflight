/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for the real FiltersPage (react-dom in the #57 fake DOM; useHost
 * stubbed by run-filters-page.mjs) over the UI mock host's gyro notch scenarios.
 * Asserts what a user sees: the visible Active/Reason cell text of each
 * tr[data-notch], the input values after a refused or accepted Save, the FC's
 * refusal line verbatim, and the command order (every notch `set` is re-read
 * with `get` before `save`). Handlers are driven through React's own props on
 * the DOM nodes (the fake DOM has no event dispatch).
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FiltersPage, LPF_RANGE_HINT } from "../src/pages/FiltersPage";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { DISCARD_EDITS_MESSAGE } from "../src/filters/gyroNotch";
import { REFRESH_CONFIRM_MESSAGE } from "../src/components/storageRefresh";
import { GYRO_NOTCH_MOCK_SCENARIOS, type GyroNotchMockScenario } from "../../protocol/src/gyro-notch-mock";
import { STORAGE_SCOPE_V7, STORAGE_SCOPE_V8 } from "../../protocol/src/storage";
import type { CliCommand, SettingsKey } from "../src/protocol";

const { container } = installFakeDom();
const win = (globalThis as { window: Record<string, unknown> }).window;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// ---- DOM reading -------------------------------------------------------------
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
/** Hidden to a user: `hidden`, aria-hidden, display:none or visibility:hidden. */
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
/** Text a user can see (hidden subtrees skipped). */
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTag = (tag: string) => container.findAll((e) => e.tagName === tag);
function row(i: 1 | 2): FakeElement {
  const tr = byTag("TR").find((e) => e.getAttribute("data-notch") === String(i));
  assert.ok(tr, `tr[data-notch=${i}] rendered`);
  return tr;
}
function column(label: string): number {
  const idx = byTag("TH").map((th) => visibleText(th)).indexOf(label);
  assert.ok(idx >= 0, `column ${label}`);
  return idx;
}
function cell(i: 1 | 2, label: "Active" | "Reason"): string {
  const tds = row(i).childNodes.filter(isEl);
  return visibleText(tds[column(label)]).trim();
}
function input(label: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && (e.getAttribute("aria-label") === label || e.getAttribute("id") === label))[0];
  assert.ok(el, `input ${label}`);
  return el;
}
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function button(text: string): FakeElement {
  const b = byTag("BUTTON").find((e) => visibleText(e).startsWith(text));
  assert.ok(b, `button ${text}`);
  return b;
}
const fcLine = () => { const p = container.findAll((e) => e.getAttribute("data-testid") === "notch-fc-line")[0]; return p ? visibleText(p) : null; };
const failText = () => container.findAll((e) => e.tagName === "P" && e.getAttribute("class") === "fail").map(visibleText);
const lastReply = () => container.findAll((e) => e.tagName === "P" && visibleText(e).startsWith("Last reply: ")).map(visibleText)[0] ?? null;

// ---- driving React handlers ----------------------------------------------------
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
async function type(el: FakeElement, value: string) { flushSync(() => reactProps(el).onChange({ target: { value }, currentTarget: { value } })); await sleep(0); }
async function check(el: FakeElement, checked: boolean) { flushSync(() => reactProps(el).onChange({ target: { checked }, currentTarget: { checked } })); await sleep(0); }
async function click(el: FakeElement) { flushSync(() => reactProps(el).onClick({})); await sleep(0); }

// ---- host rig -----------------------------------------------------------------
const storageReply = (schema: number, dirty: boolean) => ["storage_api: 1", "backend: flash", `schema: ${schema}`, `state: ${dirty ? "dirty" : "saved"}`, `dirty: ${dirty ? 1 : 0}`,
  "generation: 2", "last_error: none", `scope: ${schema >= 8 ? STORAGE_SCOPE_V8 : STORAGE_SCOPE_V7}`, "armed: 0", "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", "storage_end: 1"].join("\r\n") + "\r\n";

interface RigOpts {
  /** Replace the FC's `filters` reply (e.g. an unknown or malformed token). */
  filters?: string;
  /** FC `storage` dirty flag. */
  fcDirty?: boolean;
  /** Keys whose `set` answers ok but the FC keeps its old value. */
  ignoreSet?: string[];
  before?: (mock: MockBobFlightHost) => Promise<void>;
}
/** UI mock host behind a recording facade; `save` stands in for a flash-backed FC. */
async function rig(scenario: GyroNotchMockScenario, o: RigOpts = {}) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroNotchScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  await o.before?.(mock);
  const ops: string[] = [];
  let loads = 0;
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    onLine: (fn: (l: string) => void) => mock.onLine(fn),
    getAllSettings: async () => { ops.push("getAll"); return mock.getAllSettings(); },
    getSetting: async (key: SettingsKey) => { ops.push(`get ${key}`); return mock.getSetting(key); },
    setSetting: async (key: SettingsKey, value: string) => {
      ops.push(`set ${key} ${value}`);
      if (o.ignoreSet?.includes(key)) return { key, value };
      return mock.setSetting(key, value);
    },
    sendCommand: async (cmd: CliCommand) => {
      ops.push(cmd);
      if (cmd === "filters" && o.filters !== undefined) return o.filters;
      if (cmd === "storage") { loads++; return storageReply(scenario === "old-fc" ? 7 : 8, o.fcDirty ?? false); }
      return mock.sendCommand(cmd);
    },
    saveSettings: async () => { ops.push("save"); },
    restoreDefaults: async () => { ops.push("defaults"); },
  };
  (globalThis as Record<string, unknown>).__setupTestHost = {
    host, connectionStatus: "connected", version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
  };
  const root: Root = createRoot(container as never);
  flushSync(() => root.render(<FiltersPage />));
  assert.ok(await waitFor(() => loads >= 1), "initial load read storage");
  await sleep(20);
  /** Wait until a re-read (`storage` is its last command) has happened after ops[from]. */
  const rereadAfter = async (from: number, what: string) => { assert.ok(await waitFor(() => from >= 0 && ops.indexOf("storage", from + 1) > from), `re-read after ${what}: ${JSON.stringify(ops)}`); await sleep(20); };
  return { mock, ops, root, loads: () => loads, rereadAfter, done: async () => { root.unmount(); await mock.disconnect(); } };
}

const report = (o: { hz?: string; a1?: string | null; r1?: string | null }) => ["filters_api: 1", `filters_sample_hz: ${o.hz ?? "1000"}`,
  ...(o.a1 === null ? [] : [`gyro_notch1_active: ${o.a1 ?? "no"}`]), ...(o.r1 === null ? [] : [`gyro_notch1_reason: ${o.r1 ?? "off"}`]),
  "gyro_notch2_active: no", "gyro_notch2_reason: off", "filters_end: 1"].join("\r\n") + "\r\n";

let passed = 0;
/** ONLY=<substring> runs just the matching tests (used to show which test catches a mutation). */
const only = process.env.ONLY;
async function test(name: string, fn: () => Promise<void>) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await test("each notch mock: visible Active/Reason cells in tr[data-notch] are the FC tokens (C1/C2)", async () => {
    const expected: Record<GyroNotchMockScenario, { a: string; r: string; center: string }> = {
      off: { a: "no", r: "off", center: "" }, ok: { a: "yes", r: "ok", center: "200" }, "above-nyquist": { a: "no", r: "above-nyquist", center: "600" },
      invalid: { a: "no", r: "invalid", center: "200" }, "old-fc": { a: "unknown", r: "unknown", center: "unknown" },
    };
    for (const s of GYRO_NOTCH_MOCK_SCENARIOS) {
      const t = await rig(s);
      const e = expected[s];
      assert.equal(cell(1, "Active"), e.a, `${s}: Active`);
      assert.equal(cell(1, "Reason"), e.r, `${s}: Reason`);
      assert.equal(input("gyro_notch1_hz").value, e.center, `${s}: centre input`);
      if (s === "old-fc") {
        for (const i of [1, 2] as const) {
          assert.deepEqual([cell(i, "Active"), cell(i, "Reason")], ["unknown", "unknown"], "old FC: unknown, never 0/off");
          for (const k of [`gyro_notch${i}_hz`, `gyro_notch${i}_cutoff_hz`]) { assert.ok(isDisabled(input(k)), `${k} disabled`); assert.equal(input(k).value, "unknown"); }
        }
      } else {
        assert.deepEqual([cell(2, "Active"), cell(2, "Reason")], ["no", "off"], `${s}: notch 2`);
      }
      await t.done();
    }
  });

  await test("unknown future tokens are shown verbatim (not mapped to ok)", async () => {
    const t = await rig("ok", { filters: report({ hz: "4000", a1: "maybe", r1: "guard-fallback" }) });
    assert.equal(cell(1, "Active"), "maybe");
    assert.equal(cell(1, "Reason"), "guard-fallback");
    await t.done();
  });

  await test("N1 on the page: sample 1000, centre 600, no reason line -> Reason 'unknown' (no inference)", async () => {
    const t = await rig("above-nyquist", { filters: report({ hz: "1000", a1: "no", r1: null }) });
    assert.equal(input("gyro_notch1_hz").value, "600");
    assert.equal(cell(1, "Reason"), "unknown");
    assert.equal(cell(1, "Active"), "no");
    await t.done();
  });

  await test("V3 on the page: malformed 'above nyquist' -> Reason 'unknown'", async () => {
    const t = await rig("above-nyquist", { filters: report({ hz: "1000", a1: "no", r1: "above nyquist" }) });
    assert.equal(cell(1, "Reason"), "unknown");
    await t.done();
  });

  await test("centre 0: cutoff input disabled but keeps the stored value", async () => {
    const t = await rig("off", { before: async (m) => { await m.setSetting("gyro_notch1_cutoff_hz", "150"); } });
    const cut = input("gyro_notch1_cutoff_hz");
    assert.ok(isDisabled(cut), "disabled while off");
    assert.equal(cut.value, "150", "stored cutoff still shown");
    await t.done();
  });

  await test("refused set through Save: FC line verbatim, input shows what the FC holds, no save (R3)", async () => {
    const t = await rig("above-nyquist");
    assert.equal(input("gyro_notch1_hz").value, "600");
    await type(input("gyro_notch1_hz"), "500");
    assert.equal(input("gyro_notch1_hz").value, "500", "draft typed");
    const before = t.ops.length;
    await click(button("Save"));
    const line = "set failed: gyro_notch1_hz must be below 450 Hz at the running 1000 Hz loop rate";
    assert.ok(await waitFor(() => fcLine() !== null), "FC line rendered");
    await t.rereadAfter(t.ops.indexOf("set gyro_notch1_hz 500", before), "the refused set");
    assert.equal(fcLine(), line, "FC line exactly as sent");
    assert.equal((await t.mock.getSetting("gyro_notch1_hz")).value, "600", "FC value unchanged");
    assert.equal(input("gyro_notch1_hz").value, "600", "input shows the FC value after the re-read, not the refused 500");
    assert.equal(cell(1, "Reason"), "above-nyquist");
    const after = t.ops.slice(before);
    const setIdx = after.indexOf("set gyro_notch1_hz 500");
    assert.ok(setIdx >= 0, JSON.stringify(after));
    assert.ok(after.indexOf("get gyro_notch1_hz", setIdx) > setIdx, "re-read with get after the refused set");
    assert.ok(!after.includes("save"), "nothing saved after a refusal");
    await t.done();
  });

  await test("accepted Save: every notch set is followed by a get of that key, all before save (S2)", async () => {
    const t = await rig("off");
    await check(input("Notch 2 enabled"), true);
    await type(input("gyro_notch2_hz"), "200");
    await type(input("gyro_notch2_cutoff_hz"), "150");
    const before = t.ops.length;
    await click(button("Save"));
    assert.ok(await waitFor(() => lastReply() === "Last reply: saved"), `saved; fail=${JSON.stringify(failText())}`);
    await t.rereadAfter(t.ops.indexOf("save", before), "save");
    const ops = t.ops.slice(before);
    const save = ops.indexOf("save");
    assert.ok(save > 0, JSON.stringify(ops));
    const sets = ops.map((op, i) => ({ op, i })).filter(({ op }) => /^set gyro_notch/.test(op));
    assert.deepEqual(sets.map((s) => s.op), ["set gyro_notch2_cutoff_hz 150", "set gyro_notch2_hz 200"], "FW-safe order");
    for (const { op, i } of sets) {
      const key = op.split(" ")[1];
      const g = ops.indexOf(`get ${key}`, i + 1);
      assert.ok(g > i && g < save, `${op}: get ${key} at ${g} must come after ${i} and before save at ${save}: ${JSON.stringify(ops)}`);
    }
    assert.ok(ops.indexOf("filters", sets[sets.length - 1].i) < save, "filters report re-read before save");
    assert.equal(input("gyro_notch2_hz").value, "200");
    assert.deepEqual([cell(2, "Active"), cell(2, "Reason")], ["yes", "ok"]);
    await t.done();
  });

  await test("FC answers ok but keeps its value: inputs follow the re-read, not the request (R3)", async () => {
    const t = await rig("off", { ignoreSet: ["gyro_notch2_hz"] });
    await check(input("Notch 2 enabled"), true);
    await type(input("gyro_notch2_hz"), "200");
    await type(input("gyro_notch2_cutoff_hz"), "150");
    const before = t.ops.length;
    await click(button("Save"));
    assert.ok(await waitFor(() => lastReply() === "Last reply: saved"));
    await t.rereadAfter(t.ops.indexOf("save", before), "save");
    assert.equal(input("gyro_notch2_hz").value, "", "FC still has centre 0 (off): the centre input is empty, not the requested 200");
    assert.equal(input("gyro_notch2_cutoff_hz").value, "150", "cutoff the FC did take");
    assert.equal(cell(2, "Reason"), "off");
    await t.done();
  });

  await test("LPF client check is not FW text and sends nothing", async () => {
    const t = await rig("off");
    await type(input("gyro_lpf_hz"), "5");
    const before = t.ops.length;
    await click(button("Save"));
    await sleep(30);
    assert.deepEqual(failText(), [`Gyro LPF (Hz): ${LPF_RANGE_HINT}`]);
    assert.equal(LPF_RANGE_HINT, "Out of range (10–1000 or 0).");
    assert.ok(failText().every((m) => !/set failed/i.test(m)), "does not look like an FC reply");
    assert.deepEqual(t.ops.slice(before), [], "nothing sent");
    await t.done();
  });

  await test("Reload: page edits ask first, then the #54 storage guard when the FC is dirty", async () => {
    const asked: string[] = [];
    let answer = false;
    win.confirm = (m: string) => { asked.push(m); return answer; };
    const t = await rig("ok", { fcDirty: true });
    await type(input("gyro_notch1_hz"), "300");
    assert.ok(visibleText(button("Reload")).includes("discard edits"));
    const n = t.ops.filter((o) => o === "getAll").length;
    await click(button("Reload"));
    await sleep(30);
    assert.deepEqual(asked, [DISCARD_EDITS_MESSAGE]);
    assert.equal(t.ops.filter((o) => o === "getAll").length, n, "declined: no reload");
    answer = true; asked.length = 0;
    const mark = t.ops.length;
    await click(button("Reload"));
    await t.rereadAfter(mark - 1, "reload");
    assert.deepEqual(asked, [DISCARD_EDITS_MESSAGE, REFRESH_CONFIRM_MESSAGE], "then the #54 guard (FC dirty)");
    assert.equal(input("gyro_notch1_hz").value, "200", "edits discarded, FC value back");
    delete win.confirm;
    await t.done();
  });

  console.log(`PASS FiltersPage render: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exitCode = 1; });
