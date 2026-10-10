/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for motor_direction (FW schema 10): the Motors-tab
 * MotorDirectionPanel and the real MotorsPage, in the #57 fake DOM (useHost
 * stubbed by run-motor-direction.mjs), over the UI mock host's motor-direction
 * scenarios, plus renderToStaticMarkup of the panel's first paint. Asserts
 * what a user sees (visible text only; hidden nodes excluded): FC tokens and
 * yaw signs verbatim (future token included), "unknown" for a missing key or
 * field, the FC refusal line verbatim with the selector back on the FC value
 * (R3), the order set -> get motor_direction -> mixer, the storage lock
 * (storageBlocked(state) || postFlashGate), the copy and the exact bench test.
 * A failing test prints `FAIL <name>` and exits 1.
 *
 * QA #60 (busy gate): the stub host has no CommandGate. `gatedHost` wires the
 * REAL CommandGate the way ProtocolHostAdapter does, so the panel's reads race
 * the real MotorsPage eRPM poll. Asserted: only the gate's refusal is retried
 * (up to MOTOR_DIRECTION_GATE_ATTEMPTS, MOTOR_DIRECTION_GATE_DELAY_MS apart),
 * the value shows once the gate frees, the older-FC banner needs the FC's own
 * "unknown key", a FW refusal or a transport error is sent once and never
 * retried, an accepted set
 * is never re-sent, an exhausted retry shows "unknown" + the gate's message,
 * and unmount stops the retries.
 *
 * #63 (Config Lead / QA): locks (armed or unknown arm, a page motor test, a
 * stop, a pending StoragePanel action, post-flash gate, not connected), the
 * read only after the host connect completed (R14, with the REAL
 * ProtocolHostAdapter from createHost over the protocol MockSerial), only a
 * real value reply enables the selector, busy/transport problems never in the
 * FC refusal slot, "Read again", own apply disables the controls (L4), a late
 * set result after a disconnect is ignored (N1), and visibleText treats a
 * closed <details> as hidden (C4/B3).
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { MotorDirectionPanel } from "../src/motors/MotorDirectionPanel";
import { MotorsPage } from "../src/pages/MotorsPage";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { CommandGate, GATE_BUSY_MESSAGE, isGateBusy } from "../src/protocol/commandGate";
import { MOTOR_DIRECTION_GATE_ATTEMPTS, MOTOR_DIRECTION_GATE_DELAY_MS, MOTOR_DIRECTION_NO_REPLY } from "../src/motors/motorDirection";
import { motorDirectionLockReason, type MotorDirectionLockInputs } from "../src/motors/motorDirectionLock";
import { parseStatus } from "../src/protocol/parseStatus";
import { HostProvider, useHost as realUseHost } from "../src/hooks/useHost";
import { ALLOWED_CLI_COMMANDS, parseCliInput, type CliCommand } from "../src/protocol/types";
import { MOTOR_DIRECTION_MOCK_SCENARIOS, type MotorDirectionMockScenario } from "../../protocol/src/motor-direction-mock";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// Literal expectations (deliberately not imported from the code under test).
const COPY_MIXER = "tells the mixer which way the props spin";
const COPY_ESC = "does not change ESC spin direction";
const BENCH = "props off, Acro, armed above 5% throttle: rotate the frame clockwise (viewed from above) by hand and the clockwise-spinning motors (viewed from above) should speed up";
const OUT_YAW = ["-1", "+1", "+1", "-1"], IN_YAW = ["+1", "-1", "-1", "+1"];

// ---- DOM reading -------------------------------------------------------------
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
/** What a user can read: hidden nodes excluded, and a closed <details> shows only its <summary> (C4/B3). */
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  const kids = n.tagName === "DETAILS" && !n.hasAttribute("open") ? n.childNodes.filter((c) => isEl(c) && c.tagName === "SUMMARY") : n.childNodes;
  return kids.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byAttr = (a: string, v?: string) => container.findAll((e) => (v === undefined ? e.hasAttribute(a) : e.getAttribute(a) === v));
const panel = () => byAttr("data-testid", "motor-direction-fc")[0];
/** The visible text of the cell a label row points at (no data attribute needed: <th>label</th><td>value</td>). */
function row(label: string): string | null {
  const th = panel()?.findAll((e) => e.tagName === "TH" && visibleText(e) === label)[0];
  if (!th) return null;
  const tr = th.parentNode as unknown as FakeElement;
  return visibleText(tr.childNodes.filter(isEl)[1]).trim();
}
function held(): string {
  const p = panel()!.findAll((e) => e.tagName === "P" && visibleText(e).startsWith("Controller holds: "))[0];
  assert.ok(p, "Controller holds line");
  return visibleText(p).slice("Controller holds: ".length).trim();
}
const mixerCells = () => ({ mixer: row("Mixer reports"), yaw: [1, 2, 3, 4].map((m) => row(`Yaw sign M${m}`)) });
function select(): FakeElement { const el = panel()!.findAll((e) => e.tagName === "SELECT" && e.getAttribute("aria-label") === "motor_direction")[0]; assert.ok(el, "select"); return el; }
/** The selector's displayed value: the controlled `value` React rendered (the fake DOM does not clear `selected` on siblings). */
function selectedOption(): string | null {
  const v = (reactProps(select()) as unknown as { value?: unknown }).value;
  if (typeof v !== "string") return null;
  assert.ok(v === "" || select().options.some((o) => o.value === v), `value ${v} is one of the rendered options`);
  return v;
}
function setButton(): FakeElement { const b = panel()!.findAll((e) => e.tagName === "BUTTON" && visibleText(e) === "Set direction on controller")[0]; assert.ok(b, "set button"); return b; }
function readAgain(): FakeElement { const b = panel()!.findAll((e) => e.tagName === "BUTTON" && visibleText(e) === "Read again")[0]; assert.ok(b, "Read again button"); return b; }
const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
const testId = (id: string) => { const p = byAttr("data-testid", id)[0]; return p ? visibleText(p) : null; };
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
const lockLine = () => testId("motor-direction-lock");
async function assertLockedNoSet(t: { ops: string[] }, why: string) {
  assert.ok(isDisabled(select()) && isDisabled(setButton()), `${why}: disabled`);
  const before = t.ops.length;
  await click(setButton()); await sleep(30);
  assert.ok(!t.ops.slice(before).some((op) => /^(try:)?set motor_direction/.test(op)), `${why}: nothing set`);
}
async function choose(value: string) { flushSync(() => reactProps(select()).onChange({ target: { value }, currentTarget: { value } })); await sleep(0); }
async function click(el: FakeElement) { flushSync(() => reactProps(el).onClick({})); await sleep(0); }

// ---- host rig -----------------------------------------------------------------
interface RigOpts { replies?: Partial<Record<string, string>>; throws?: Partial<Record<string, string>>; gyroHealthy?: boolean; }
async function mockHost(scenario: MotorDirectionMockScenario, o: RigOpts = {}) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: o.gyroHealthy ?? true, rpmFilterScenario: "off", motorDirectionScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const ops: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const hold = (cmd: string) => { let release = () => {}; gates.set(cmd, new Promise<void>((r) => { release = () => { gates.delete(cmd); r(); }; })); return () => release(); };
  /** The FC processes the command at once but its reply is delivered only on release (a late result). */
  const lates = new Map<string, Promise<void>>();
  const holdReply = (cmd: string) => { let release = () => {}; lates.set(cmd, new Promise<void>((r) => { release = () => { lates.delete(cmd); r(); }; })); return () => release(); };
  /** `status` arm line override: a token, or null to drop the line (arming state unknown). */
  const statusArm: { value?: string | null } = {};
  const logged: Record<string, (...a: never[]) => unknown> = {
    sendCommand: async (cmd: CliCommand) => {
      ops.push(cmd);
      const x = o.throws?.[cmd];
      if (x !== undefined) throw new Error(x);
      const r = o.replies?.[cmd];
      if (r !== undefined) return r;
      const gate = gates.get(cmd);
      if (gate) await gate;
      let reply = await mock.sendCommand(cmd);
      if (cmd === "status" && statusArm.value !== undefined) reply = reply.replace(/^arm: .*\r?\n/m, statusArm.value === null ? "" : `arm: ${statusArm.value}\r\n`);
      const late = lates.get(cmd);
      if (late) await late;
      return reply;
    },
    getStatus: async () => parseStatus(await (logged.sendCommand as (c: CliCommand) => Promise<string>)("status" as CliCommand)),
  };
  const host = new Proxy(mock, {
    get(target, prop) {
      if (typeof prop === "string" && prop in logged) return logged[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as MockBobFlightHost;
  return { mock, host, ops, hold, holdReply, statusArm };
}
async function panelRig(scenario: MotorDirectionMockScenario, o: RigOpts = {}) {
  const h = await mockHost(scenario, o);
  const root: Root = createRoot(container as never);
  const render = (p: { ready?: boolean; lock?: string | null } = {}) =>
    flushSync(() => root.render(<MotorDirectionPanel host={h.host} ready={p.ready ?? true} lock={p.lock ?? null} />));
  render();
  assert.ok(await waitFor(() => h.ops.includes("get motor_direction") && held() !== "reading…"), `panel read: ${JSON.stringify(h.ops)}`);
  await sleep(20);
  return { ...h, render, done: async () => { root.unmount(); await h.mock.disconnect(); } };
}
async function motorsPage(postFlashGate: boolean, o: RigOpts & { holdStorage?: boolean } = {}) {
  (globalThis as Record<string, unknown>).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const h = await mockHost("props-out", o);
  const releaseStorage = o.holdStorage ? h.hold("storage") : () => {};
  const ctx: Record<string, unknown> = {
    host: h.host, connectionStatus: "connected", version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate,
  };
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  const root: Root = createRoot(container as never);
  const render = () => flushSync(() => root.render(<MotorsPage />));
  render();
  assert.ok(await waitFor(() => !!panel() && held() === "props-out"), `direction panel rendered: ${JSON.stringify(h.ops)}`);
  return { ...h, ctx, render, releaseStorage, done: async () => { releaseStorage(); root.unmount(); await sleep(20); await h.mock.disconnect(); delete (globalThis as Record<string, unknown>).document; } };
}

let passed = 0, failed = 0;
const only = process.env.ONLY;
async function test(name: string, fn: () => Promise<void>) {
  if (only && !name.includes(only)) return;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}`); console.log(e instanceof Error ? `Assertion: ${e.message.split("\n")[0]}` : String(e)); container.childNodes.splice(0); }
}

async function main() {
  await test("each mock: visible cells are the FC tokens and signs verbatim (C1)", async () => {
    const want: Record<MotorDirectionMockScenario, { held: string; mixer: string | null; yaw: (string | null)[]; sel: string | null }> = {
      "props-out": { held: "props-out", mixer: "props-out", yaw: OUT_YAW, sel: "props-out" },
      "props-in": { held: "props-in", mixer: "props-in", yaw: IN_YAW, sel: "props-in" },
      "refused-armed": { held: "props-out", mixer: "props-out", yaw: OUT_YAW, sel: "props-out" },
      "refused-motor-test": { held: "props-out", mixer: "props-out", yaw: OUT_YAW, sel: "props-out" },
      "unknown-token": { held: "props-mixed", mixer: "props-mixed", yaw: OUT_YAW, sel: "" },
      "old-fc": { held: "unknown", mixer: null, yaw: [null, null, null, null], sel: "" },
    };
    for (const s of MOTOR_DIRECTION_MOCK_SCENARIOS) {
      const t = await panelRig(s);
      const w = want[s];
      assert.deepEqual({ held: held(), ...mixerCells(), sel: selectedOption() }, { held: w.held, mixer: w.mixer, yaw: w.yaw, sel: w.sel }, s);
      await t.done();
    }
  });

  await test("renderToStaticMarkup first paint: reading…, copy and the exact bench test, no FC value invented", async () => {
    const h = await mockHost("props-in");
    const html = renderToStaticMarkup(<MotorDirectionPanel host={h.host} ready={true} lock={null} />);
    assert.match(html, /Controller holds: <code[^>]*>reading…<\/code>/);
    assert.ok(!/props-in<\/code>/.test(html), "nothing shown before the FC answers");
    assert.ok(html.includes(COPY_MIXER) && html.includes(COPY_ESC), "copy");
    assert.ok(html.includes(BENCH), "bench test text exactly");
    await h.mock.disconnect();
  });

  await test("visible copy: mixer/ESC wording and the bench test exactly", async () => {
    const t = await panelRig("props-out");
    const copy = testId("motor-direction-copy")!;
    assert.ok(copy.includes(COPY_MIXER) && copy.includes(COPY_ESC), copy);
    assert.equal(testId("motor-direction-bench"), `Bench test after any change: ${BENCH}`);
    assert.match(BENCH, /rotate the frame clockwise \(viewed from above\)/, "safety copy: viewed from above");
    await t.done();
  });

  await test("visibleText: a closed <details> shows only its <summary>; open shows all (C4/B3 harness)", async () => {
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<div data-testid="d"><details><summary>Sum</summary><p>inner</p></details></div>));
    assert.equal(testId("d"), "Sum");
    flushSync(() => root.render(<div data-testid="d"><details open><summary>Sum</summary><p>inner</p></details></div>));
    assert.equal(testId("d"), "Suminner");
    root.unmount();
  });

  await test("disclaimer and bench test are separate visible elements, each shown once (C4/B3)", async () => {
    const t = await panelRig("props-out");
    const copyEl = byAttr("data-testid", "motor-direction-copy")[0], benchEl = byAttr("data-testid", "motor-direction-bench")[0];
    assert.ok(copyEl && benchEl && copyEl !== benchEl, "two elements");
    assert.ok(!copyEl.findAll((e) => e === benchEl).length && !benchEl.findAll((e) => e === copyEl).length, "neither contains the other");
    assert.ok(!visibleText(copyEl).includes(BENCH), "bench test not merged into the disclaimer");
    assert.ok(!visibleText(benchEl).includes(COPY_MIXER), "disclaimer not merged into the bench test");
    const all = visibleText(panel()!);
    assert.equal(all.split(BENCH).length - 1, 1, "bench test visible exactly once");
    assert.equal(all.split(COPY_MIXER).length - 1, 1, "disclaimer visible exactly once");
    await t.done();
  });

  await test("accepted set: set -> get motor_direction -> mixer, cells follow the re-read", async () => {
    const t = await panelRig("props-out");
    await choose("props-in");
    const before = t.ops.length;
    await click(setButton());
    assert.ok(await waitFor(() => held() === "props-in" && !isDisabled(select())), `FC now holds props-in: ${JSON.stringify(t.ops)}`);
    assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in", "get motor_direction", "mixer"]);
    assert.deepEqual(mixerCells(), { mixer: "props-in", yaw: IN_YAW });
    assert.equal(selectedOption(), "props-in");
    assert.equal(testId("motor-direction-fc-line"), null);
    await t.done();
  });

  await test("FC answers ok but the re-read says otherwise: the page shows the re-read (no optimistic update)", async () => {
    const t = await panelRig("props-out", { replies: { "set motor_direction props-in": "ok motor_direction=props-in\r\n" } });
    await choose("props-in");
    await click(setButton());
    assert.ok(await waitFor(() => t.ops.filter((x) => x === "mixer").length >= 2));
    await sleep(20);
    assert.equal(held(), "props-out", "the mock FC never changed: the re-read wins");
    assert.equal(row("Mixer reports"), "props-out");
    assert.equal(selectedOption(), "props-out");
    await t.done();
  });

  for (const [scenario, line] of [["refused-armed", "set failed: armed"], ["refused-motor-test", "set failed: motor test running"]] as const) {
    await test(`refused set (${scenario}): FC line verbatim, selector back on the FC value, value re-read (R3)`, async () => {
      const t = await panelRig(scenario);
      await choose("props-in");
      assert.equal(selectedOption(), "props-in", "draft selected before Set");
      const before = t.ops.length;
      await click(setButton());
      assert.ok(await waitFor(() => testId("motor-direction-fc-line") !== null), JSON.stringify(t.ops));
      assert.equal(testId("motor-direction-fc-line"), line);
      assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in", "get motor_direction", "mixer"]);
      assert.equal(selectedOption(), "props-out", "control back on what the FC holds");
      assert.equal(held(), "props-out");
      assert.deepEqual(mixerCells(), { mixer: "props-out", yaw: OUT_YAW });
      await t.done();
    });
  }

  await test("real armed FC (mock armed via `arm`): the existing armed line verbatim", async () => {
    const t = await panelRig("props-out");
    await t.mock.sendCommand("arm");
    await choose("props-in");
    await click(setButton());
    assert.ok(await waitFor(() => testId("motor-direction-fc-line") !== null));
    assert.equal(testId("motor-direction-fc-line"), "set failed: armed");
    assert.equal(selectedOption(), "props-out");
    await t.done();
  });

  await test("unknown future token: shown verbatim, nothing pre-selected, Set disabled until a known token is chosen", async () => {
    const t = await panelRig("unknown-token");
    assert.equal(held(), "props-mixed");
    assert.ok(isDisabled(setButton()), "no draft -> disabled");
    const before = t.ops.length;
    await click(setButton());
    await sleep(30);
    assert.deepEqual(t.ops.slice(before), [], "nothing sent");
    await choose("props-out");
    assert.ok(!isDisabled(setButton()));
    await click(setButton());
    assert.ok(await waitFor(() => held() === "props-out"));
    assert.ok(t.ops.slice(before).every((op) => !/props-mixed/.test(op)), "the unknown token is never sent");
    await t.done();
  });

  await test("old FC (unknown key): unknown, banner, controls disabled, no mixer read, nothing set", async () => {
    const t = await panelRig("old-fc");
    assert.equal(held(), "unknown");
    assert.ok(testId("motor-direction-old-fc"));
    assert.ok(isDisabled(select()) && isDisabled(setButton()));
    assert.deepEqual(t.ops, ["get motor_direction"]);
    await t.done();
  });

  await test("missing / malformed FC fields show unknown (never a default)", async () => {
    const report = (lines: string[]) => ["mixer_api: 1", ...lines, "mixer_end: 1"].join("\r\n") + "\r\n";
    const cases: Array<[Partial<Record<string, string>>, string, string | null, (string | null)[]]> = [
      [{ "get motor_direction": "motor_direction=\r\n" }, "unknown", "props-out", OUT_YAW],
      [{ "get motor_direction": "garbage\r\n" }, "unknown", "props-out", OUT_YAW],
      [{ mixer: report(["mixer: quadx", "mixer_yaw_m1: -1", "mixer_yaw_m2: +1", "mixer_yaw_m3: +1"]) }, "props-out", "unknown", ["-1", "+1", "+1", "unknown"]],
      [{ mixer: report(["mixer: quadx", "motor_direction: props-out", "motor_direction: props-in", "mixer_yaw_m1: 1", "mixer_yaw_m2: +2", "mixer_yaw_m3: +1", "mixer_yaw_m4: -1"]) }, "props-out", "unknown", ["unknown", "unknown", "+1", "-1"]],
      [{ mixer: "mixer_api: 1\r\nmotor_direction: props-out\r\n" }, "props-out", "unknown", ["unknown", "unknown", "unknown", "unknown"]],
    ];
    for (const [replies, wantHeld, wantMixer, wantYaw] of cases) {
      const t = await panelRig("props-out", { replies });
      assert.deepEqual({ held: held(), ...mixerCells() }, { held: wantHeld, mixer: wantMixer, yaw: wantYaw }, JSON.stringify(replies));
      await t.done();
    }
  });

  await test("disconnect clears the panel; reads only once the host connect completed (ready), never on raw connected (R14)", async () => {
    const t = await panelRig("props-in");
    await t.mock.disconnect();
    assert.ok(await waitFor(() => held() === "not connected"), `stale value dropped: ${held()}`);
    assert.ok(isDisabled(select()) && isDisabled(setButton()) && isDisabled(readAgain()));
    assert.equal(row("Mixer reports"), null, "no stale mixer cells");
    t.render({ ready: false });
    const before = t.ops.length;
    await t.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    await sleep(80);
    assert.deepEqual(t.ops.slice(before), [], "raw connected is not a read trigger");
    t.render({ ready: true });
    assert.ok(await waitFor(() => held() === "props-in"), held());
    assert.deepEqual(t.ops.slice(before), ["get motor_direction", "mixer"]);
    await t.done();
  });

  await test("mount while disconnected: no read, 'not connected', Read again disabled", async () => {
    const h = await mockHost("props-out");
    await h.mock.disconnect();
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorDirectionPanel host={h.host} ready={true} lock={null} />));
    await sleep(60);
    assert.deepEqual(h.ops, [], "nothing sent while disconnected");
    assert.equal(held(), "not connected");
    assert.ok(isDisabled(select()) && isDisabled(setButton()) && isDisabled(readAgain()));
    root.unmount();
  });

  await test("own apply disables selector, Set and Read again until the re-read lands (L4)", async () => {
    const t = await panelRig("props-out");
    await choose("props-in");
    const release = t.hold("set motor_direction props-in");
    await click(setButton());
    assert.ok(await waitFor(() => t.ops.includes("set motor_direction props-in")));
    assert.ok(isDisabled(select()) && isDisabled(setButton()) && isDisabled(readAgain()), "controls disabled during the apply");
    const before = t.ops.length;
    await click(setButton()); await click(readAgain());
    await sleep(30);
    assert.deepEqual(t.ops.slice(before), [], "no second set / read while applying");
    release();
    assert.ok(await waitFor(() => held() === "props-in" && !isDisabled(select())));
    assert.equal(count(t.ops, "set motor_direction props-in"), 1);
    await t.done();
  });

  await test("malformed get: selector stays disabled, 'Read again' reads once more and recovers", async () => {
    const replies: Partial<Record<string, string>> = { "get motor_direction": "BobFlight 0.1.0 ready\r\nmotor_direction=props-out\r\n" };
    const t = await panelRig("props-out", { replies });
    assert.equal(held(), "unknown");
    assert.ok(isDisabled(select()) && isDisabled(setButton()), "malformed reply never enables the selector");
    assert.equal(testId("motor-direction-old-fc"), null, "not the older-FC banner");
    assert.ok(!isDisabled(readAgain()));
    delete replies["get motor_direction"];
    const before = t.ops.length;
    await click(readAgain());
    assert.ok(await waitFor(() => held() === "props-out" && !isDisabled(select())), held());
    assert.deepEqual(t.ops.slice(before), ["get motor_direction", "mixer"], "Read again: get -> mixer");
    await t.done();
  });

  await test("empty set reply: no FC line, the 'no reply' problem shown, then get -> mixer", async () => {
    const t = await panelRig("props-out", { replies: { "set motor_direction props-in": "" } });
    await choose("props-in");
    const before = t.ops.length;
    await click(setButton());
    assert.ok(await waitFor(() => testId("motor-direction-error") !== null), JSON.stringify(t.ops));
    assert.equal(testId("motor-direction-error"), `No controller reply: ${MOTOR_DIRECTION_NO_REPLY}`);
    assert.equal(testId("motor-direction-fc-line"), null, "nothing in the FC refusal slot");
    assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in", "get motor_direction", "mixer"]);
    await t.done();
  });

  await test("late set result after a disconnect is ignored (N1)", async () => {
    const t = await panelRig("props-out");
    await choose("props-in");
    const release = t.holdReply("mixer");
    const before = t.ops.length;
    await click(setButton());
    assert.ok(await waitFor(() => t.ops.slice(before).includes("mixer")), JSON.stringify(t.ops.slice(before)));
    await t.mock.disconnect();
    assert.ok(await waitFor(() => held() === "not connected"));
    t.render({ ready: false });
    await t.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    release();
    await sleep(60);
    assert.equal(held(), "not connected", "the late result never fills the panel");
    assert.equal(row("Mixer reports"), null);
    assert.equal(testId("motor-direction-fc-line"), null);
    assert.ok(isDisabled(select()) && isDisabled(setButton()));
    await t.done();
  });

  await test("disconnect during a set aborts the apply: nothing more is sent after a reconnect", async () => {
    const t = await panelRig("props-out");
    await choose("props-in");
    const release = t.holdReply("set motor_direction props-in");
    const before = t.ops.length;
    await click(setButton());
    assert.ok(await waitFor(() => t.ops.slice(before).includes("set motor_direction props-in")));
    await t.mock.disconnect();
    assert.ok(await waitFor(() => held() === "not connected"));
    await t.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    release();
    await sleep(60);
    assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in"], "no get / mixer of the old apply in the new session");
    assert.equal(held(), "not connected");
    await t.done();
  });

  await test("canSet checks the link itself (host without onStatus: a stale value cannot be set after a disconnect)", async () => {
    const h = await mockHost("props-out");
    const host = new Proxy(h.host, { get: (t, k) => (k === "onStatus" ? undefined : Reflect.get(t, k)) }) as MockBobFlightHost;
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorDirectionPanel host={host} ready={true} lock={null} />));
    assert.ok(await waitFor(() => held() === "props-out" && !isDisabled(select())));
    await h.mock.disconnect();
    await choose("props-in"); // re-render with the link down (no status event reaches the panel)
    assert.ok(isDisabled(select()) && isDisabled(setButton()), "disabled once the link is down");
    const before = h.ops.length;
    await click(setButton()); await sleep(30);
    assert.deepEqual(h.ops.slice(before), [], "nothing sent");
    root.unmount();
  });

  await test("late read result after a disconnect is ignored (N1)", async () => {
    const h = await mockHost("props-in");
    const release = h.holdReply("mixer");
    const root: Root = createRoot(container as never);
    const render = (ready: boolean) => flushSync(() => root.render(<MotorDirectionPanel host={h.host} ready={ready} lock={null} />));
    render(true);
    assert.ok(await waitFor(() => h.ops.includes("mixer")));
    await h.mock.disconnect();
    render(false);
    await h.mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    release();
    await sleep(60);
    assert.equal(held(), "not connected");
    assert.ok(isDisabled(select()));
    root.unmount(); await h.mock.disconnect();
  });

  await test("lock reason: each input alone locks; only all-clear with arm exactly 'disarmed' unlocks", async () => {
    const clear: MotorDirectionLockInputs = { connected: true, postFlashGate: false, arm: "disarmed", motorTestRunning: false, storageBlocked: false, storagePending: false };
    assert.equal(motorDirectionLockReason(clear), null);
    const one: Array<[Partial<MotorDirectionLockInputs>, string]> = [
      [{ connected: false }, "Locked: not connected."],
      [{ postFlashGate: true }, "Locked after flashing until the controller reconnects and reports its version."],
      [{ arm: "armed" }, "Locked: the controller reports arm: armed (must be disarmed)."],
      [{ arm: "ARMED-X" }, "Locked: the controller reports arm: ARMED-X (must be disarmed)."],
      [{ arm: undefined }, "Locked: arming state unknown (the controller must report arm: disarmed)."],
      [{ arm: null }, "Locked: arming state unknown (the controller must report arm: disarmed)."],
      [{ arm: "" }, "Locked: arming state unknown (the controller must report arm: disarmed)."],
      [{ motorTestRunning: true }, "Locked while a motor test runs."],
      [{ storageBlocked: true }, "Locked while a motor test request or stop is in flight."],
      [{ storagePending: true }, "Locked while a controller storage action (save, refresh or export) is pending."],
    ];
    for (const [patch, want] of one) assert.equal(motorDirectionLockReason({ ...clear, ...patch }), want, JSON.stringify(patch));
  });

  await test("a lock disables selector and Set, shows the reason, and click sends nothing", async () => {
    const t = await panelRig("props-out");
    await choose("props-in");
    t.render({ lock: "Locked while a motor test runs." });
    assert.equal(testId("motor-direction-lock"), "Locked while a motor test runs.");
    assert.ok(isDisabled(select()) && isDisabled(setButton()));
    const before = t.ops.length;
    await click(setButton()); await sleep(30);
    assert.deepEqual(t.ops.slice(before), []);
    t.render({ lock: null });
    assert.ok(!isDisabled(select()));
    await t.done();
  });

  await test("MotorsPage: direction panel sits right after the motor_poles panel", async () => {
    const t = await motorsPage(false);
    const poles = byAttr("data-testid", "motor-poles-fc")[0];
    assert.ok(poles, "motor_poles panel");
    const sibs = (poles.parentNode as unknown as FakeElement).childNodes.filter(isEl);
    assert.equal(sibs[sibs.indexOf(poles) + 1], panel(), "next sibling is the motor direction panel");
    await t.done();
  });

  await test("MotorsPage post-flash gate: selector and button disabled, click sends nothing (lock)", async () => {
    const t = await motorsPage(true);
    await choose("props-in");
    assert.ok(isDisabled(select()) && isDisabled(setButton()), "both disabled under the post-flash gate");
    assert.equal(lockLine(), "Locked after flashing until the controller reconnects and reports its version.");
    const before = t.ops.length;
    await click(setButton());
    await sleep(40);
    assert.ok(!t.ops.slice(before).some((op) => op.startsWith("set motor_direction")), JSON.stringify(t.ops.slice(before)));
    assert.equal(await t.mock.sendCommand("get motor_direction"), "motor_direction=props-out\r\n");
    await t.done();
  });

  await test("MotorsPage stop in flight (storageBlocked): locked until the stop settles (lock)", async () => {
    const t = await motorsPage(false);
    assert.ok(await waitFor(() => !isDisabled(select())), "unlocked when idle");
    await choose("props-in");
    assert.ok(!isDisabled(setButton()));
    const release = t.hold("motor_test 0");
    const stop = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).startsWith("Stop all motor tests"))[0];
    await click(stop);
    assert.ok(await waitFor(() => isDisabled(select()) && isDisabled(setButton())), "locked while the stop is in flight");
    assert.equal(lockLine(), "Locked while a motor test request or stop is in flight.");
    const before = t.ops.length;
    await click(setButton());
    await sleep(40);
    assert.ok(!t.ops.slice(before).some((op) => op.startsWith("set motor_direction")), "nothing set during the stop");
    release();
    assert.ok(await waitFor(() => !isDisabled(setButton())), "unlocked after the stop settles");
    await t.done();
  });

  await test("MotorsPage armed (FC status arm: armed): locked with the token verbatim until disarmed", async () => {
    const t = await motorsPage(false);
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select())), `idle unlock: ${lockLine()}`);
    await choose("props-in");
    await t.mock.sendCommand("arm" as CliCommand);
    assert.ok(await waitFor(() => lockLine() === "Locked: the controller reports arm: armed (must be disarmed)."), String(lockLine()));
    await assertLockedNoSet(t, "armed");
    await t.mock.sendCommand("disarm" as CliCommand);
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select())));
    await t.done();
  });

  await test("MotorsPage arming state unknown (no arm line): locked", async () => {
    const t = await motorsPage(false);
    assert.ok(await waitFor(() => lockLine() === null));
    t.statusArm.value = null;
    assert.ok(await waitFor(() => lockLine() === "Locked: arming state unknown (the controller must report arm: disarmed)."), String(lockLine()));
    await assertLockedNoSet(t, "unknown arm");
    t.statusArm.value = undefined;
    assert.ok(await waitFor(() => lockLine() === null));
    await t.done();
  });

  await test("MotorsPage StoragePanel refresh pending: locked until it settles; StoragePanel not blocked by it", async () => {
    const t = await motorsPage(false, { holdStorage: true });
    assert.ok(await waitFor(() => lockLine() === "Locked while a controller storage action (save, refresh or export) is pending."), String(lockLine()));
    await assertLockedNoSet(t, "storage pending");
    t.releaseStorage();
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select())), String(lockLine()));
    await t.done();
  });

  await test("MotorsPage host not connected: 'Locked: not connected.', no read", async () => {
    const t = await motorsPage(false);
    await t.mock.disconnect();
    t.ctx.connectionStatus = "disconnected"; t.ctx.version = null; t.render();
    assert.ok(await waitFor(() => lockLine() === "Locked: not connected." && held() === "not connected"), String(lockLine()));
    assert.ok(isDisabled(select()) && isDisabled(setButton()) && isDisabled(readAgain()));
    await t.done();
  });

  await test("allowlist: only the two known tokens can be sent", async () => {
    for (const c of ["get motor_direction", "set motor_direction props-out", "set motor_direction props-in", "mixer"]) {
      assert.ok((ALLOWED_CLI_COMMANDS as readonly string[]).includes(c), c);
      assert.equal(parseCliInput(c), c);
    }
    for (const c of ["set motor_direction props-mixed", "set motor_direction 1", "set motor_direction"]) assert.equal(parseCliInput(c), null, c);
    const h = await mockHost("props-out");
    await assert.rejects(h.mock.sendCommand("set motor_direction props-mixed" as CliCommand), /unsupported CLI command/);
    await h.mock.disconnect();
  });

  // ---- QA #60: the real CommandGate --------------------------------------------
  /** The rig's host behind a real CommandGate (as ProtocolHostAdapter wires it): refusals are
   * recorded in `refused` (nothing sent), what reached the FC is in `ops`. `latencyMs` models the
   * serial round trip; `grabAfter` makes another command take the gate right after the named
   * command completes (e.g. after the set, before the panel's `get`). */
  async function gatedHost(scenario: MotorDirectionMockScenario, o: RigOpts & { latencyMs?: number; grabAfter?: { cmd: string; ms: number } } = {}) {
    const h = await mockHost(scenario, o);
    const gate = new CommandGate(() => 1);
    const refused: string[] = [];
    const inner = h.host;
    const g = <T,>(label: string, work: () => Promise<T>, stop = false): Promise<T> =>
      gate.run(async () => { if (o.latencyMs) await sleep(o.latencyMs); return work(); }, stop)
        .catch((e: unknown) => { if (isGateBusy(e)) refused.push(label); throw e; });
    const holdGate = (label = "get erpm_m1") => { const release = h.hold(label); const done = inner.sendCommand(label as CliCommand).catch(() => "");
      const p = g(label, () => done); return { release, done: p }; };
    const wrapped: Record<string, unknown> = {
      getStatus: () => g("status", () => inner.getStatus()),
      getVersion: () => g("version", () => inner.getVersion()),
      getAllSettings: () => g("getAll", () => inner.getAllSettings()),
      getSetting: (key: never) => g(`get ${key}`, () => inner.getSetting(key)),
      setSetting: (key: never, value: string) => g(`set ${key} ${value}`, () => inner.setSetting(key, value)),
      sendCommand: async (cmd: CliCommand) => {
        const r = await g(cmd, () => inner.sendCommand(cmd), cmd === "motor_test 0");
        if (o.grabAfter && cmd === o.grabAfter.cmd) { const held = holdGate("get erpm_m2"); setTimeout(held.release, o.grabAfter.ms); }
        return r;
      },
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
    return { ...h, host, refused, holdGate };
  }
  const notPoll = (op: string) => !/^get erpm_m\d$/.test(op);
  function mountPanel(host: MockBobFlightHost) { const root: Root = createRoot(container as never); flushSync(() => root.render(<MotorDirectionPanel host={host} ready={true} lock={null} />)); return root; }

  await test("real gate + real MotorsPage poll: direction panel shows the FC value (QA #60)", async () => {
    (globalThis as Record<string, unknown>).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    const t = await gatedHost("props-in", { latencyMs: 5 });
    (globalThis as Record<string, unknown>).__setupTestHost = {
      host: t.host, connectionStatus: "connected", version: "BobFlight test", status: null,
      refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
    };
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<MotorsPage />));
    assert.ok(await waitFor(() => !!panel() && held() === "props-in" && mixerCells().mixer === "props-in", 5000),
      `direction panel shows the FC value under the real poll: "${panel() ? held() : "(no panel)"}" refused=${JSON.stringify(t.refused)}`);
    assert.ok(t.refused.includes("get motor_direction") || t.refused.includes("mixer"), `the race happened (the poll held the gate): ${JSON.stringify(t.refused)}`);
    assert.equal(count(t.ops, "get motor_direction"), 1, "get reached the FC exactly once");
    assert.equal(count(t.ops, "mixer"), 1, "mixer reached the FC exactly once");
    assert.ok(t.ops.indexOf("mixer") > t.ops.indexOf("get motor_direction"), "get -> mixer");
    assert.deepEqual(mixerCells().yaw, IN_YAW);
    assert.equal(testId("motor-direction-old-fc"), null);
    assert.equal(testId("motor-direction-busy"), null);
    assert.ok(!isDisabled(select()), "selectable when idle");
    root.unmount(); await sleep(20); await t.mock.disconnect(); delete (globalThis as Record<string, unknown>).document;
  });

  await test("real gate: panel mounted while an eRPM poll holds the gate shows the FC value once it frees (QA #60)", async () => {
    const t = await gatedHost("props-out");
    const poll = t.holdGate();
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => t.refused.includes("get motor_direction"), 1000), `refused by the busy gate: ${JSON.stringify(t.refused)}`);
    await sleep(250);
    assert.ok(!t.ops.includes("get motor_direction"), "nothing reached the FC while the gate was held");
    assert.equal(held(), "reading…", "still retrying: not unknown / older FC while the gate is busy");
    assert.equal(testId("motor-direction-old-fc"), null);
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out", 1500), `value after the gate frees: ${held()}`);
    assert.deepEqual(t.ops.filter(notPoll), ["get motor_direction", "mixer"], "get -> mixer, each sent once");
    assert.deepEqual(mixerCells().yaw, OUT_YAW);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: older FC behind a busy gate -> banner only after the FC answers 'unknown key' (QA #60)", async () => {
    const t = await gatedHost("old-fc");
    const poll = t.holdGate();
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => t.refused.includes("get motor_direction"), 1000));
    await sleep(150);
    assert.equal(testId("motor-direction-old-fc"), null, "no older-FC banner while the read is only refused by the gate");
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => testId("motor-direction-old-fc") !== null, 1500), "older-FC banner after the FC's own reply");
    assert.equal(held(), "unknown");
    assert.ok(!t.ops.includes("mixer") && !t.ops.some((op) => op.startsWith("set ")), JSON.stringify(t.ops));
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: FW refusal ('set failed: armed') is sent once, shown verbatim, never retried (QA #60)", async () => {
    const t = await gatedHost("props-out");
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out"));
    await t.mock.sendCommand("arm" as CliCommand);
    await choose("props-in");
    const before = t.ops.length;
    const t0 = Date.now();
    await click(setButton());
    assert.ok(await waitFor(() => testId("motor-direction-fc-line") !== null, 1500));
    assert.equal(testId("motor-direction-fc-line"), "set failed: armed");
    assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in", "get motor_direction", "mixer"], "set once, then get -> mixer");
    assert.ok(Date.now() - t0 < 2 * MOTOR_DIRECTION_GATE_DELAY_MS + 500, `no retry delay: ${Date.now() - t0} ms`);
    assert.equal(held(), "props-out");
    assert.equal(selectedOption(), "props-out", "selector back on the FC value");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: an accepted set is never re-sent; only the get waits for the gate (QA #60)", async () => {
    const t = await gatedHost("props-out", { grabAfter: { cmd: "set motor_direction props-in", ms: 250 } });
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out"));
    await choose("props-in");
    const before = t.ops.length;
    await click(setButton());
    assert.ok(await waitFor(() => held() === "props-in" && mixerCells().mixer === "props-in", 2000), `FC holds props-in: ${JSON.stringify(t.ops.slice(before))}`);
    assert.ok(t.refused.includes("get motor_direction"), `the get after the set was refused by the gate: ${JSON.stringify(t.refused)}`);
    assert.deepEqual(t.ops.slice(before).filter(notPoll), ["set motor_direction props-in", "get motor_direction", "mixer"], "set exactly once, then get -> mixer");
    assert.equal(testId("motor-direction-fc-line"), null);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a set refused by the busy gate is retried, then sent once (QA #60)", async () => {
    const t = await gatedHost("props-out");
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out"));
    await choose("props-in");
    const before = t.ops.length;
    const poll = t.holdGate();
    await click(setButton());
    assert.ok(await waitFor(() => t.refused.includes("set motor_direction props-in"), 1000), `the set was refused by the busy gate: ${JSON.stringify(t.refused)}`);
    await sleep(250);
    assert.ok(!t.ops.slice(before).includes("set motor_direction props-in"), "nothing set while the gate is held");
    assert.equal(testId("motor-direction-fc-line"), null, "no error line while retrying");
    poll.release(); await poll.done;
    assert.ok(await waitFor(() => held() === "props-in" && mixerCells().mixer === "props-in", 1500), `FC holds props-in after the gate frees: ${JSON.stringify(t.ops.slice(before))}`);
    assert.deepEqual(t.ops.slice(before).filter(notPoll), ["set motor_direction props-in", "get motor_direction", "mixer"], "set once, then get -> mixer");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: the mixer report refused after the get is retried (cells show) (QA #60)", async () => {
    const t = await gatedHost("props-in", { grabAfter: { cmd: "get motor_direction", ms: 250 } });
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => t.refused.includes("mixer"), 1000), `the report was refused by the busy gate: ${JSON.stringify(t.refused)}`);
    assert.ok(await waitFor(() => mixerCells().mixer === "props-in", 1500), `mixer cells show once the gate frees: ${JSON.stringify(t.ops)}`);
    assert.deepEqual(mixerCells().yaw, IN_YAW);
    assert.equal(count(t.ops, "mixer"), 1, "report sent once");
    assert.equal(count(t.ops, "get motor_direction"), 1, "get sent once");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: mixer report refused for every try -> cells 'unknown' + the gate's message, value kept, not older FC (QA #60)", async () => {
    const budget = MOTOR_DIRECTION_GATE_ATTEMPTS * MOTOR_DIRECTION_GATE_DELAY_MS;
    const t = await gatedHost("props-in", { grabAfter: { cmd: "get motor_direction", ms: budget + 1500 } });
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => testId("motor-direction-busy") !== null, budget + 1500), `report busy shown: refused=${count(t.refused, "mixer")}`);
    assert.equal(testId("motor-direction-busy"), GATE_BUSY_MESSAGE);
    assert.equal(held(), "props-in", "the value the FC did answer is shown");
    assert.equal(mixerCells().mixer, "unknown");
    assert.deepEqual(mixerCells().yaw, ["unknown", "unknown", "unknown", "unknown"]);
    assert.equal(testId("motor-direction-old-fc"), null, "never the older-FC banner");
    assert.equal(count(t.refused, "mixer"), MOTOR_DIRECTION_GATE_ATTEMPTS, "bounded");
    assert.ok(!t.ops.includes("mixer"));
    root.unmount(); await sleep(1600); await t.mock.disconnect();
  });

  await test("real gate: a malformed FC reply is not retried (one get, 'unknown', no busy line) (QA #60)", async () => {
    const t = await gatedHost("props-out", { replies: { "get motor_direction": "motor_direction=\r\n" } });
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "unknown", 1000), held());
    await sleep(3 * MOTOR_DIRECTION_GATE_DELAY_MS);
    assert.equal(count(t.ops, "get motor_direction"), 1, `one get only: ${JSON.stringify(t.ops)}`);
    assert.equal(testId("motor-direction-busy"), null);
    assert.equal(testId("motor-direction-old-fc"), null);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a transport error on the set is never retried (sent once, message verbatim, then get -> mixer) (QA #60)", async () => {
    const t = await gatedHost("props-out", { throws: { "set motor_direction props-in": "serial timeout: no reply within 1000 ms" } });
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out"));
    await choose("props-in");
    const before = t.ops.length;
    const t0 = Date.now();
    await click(setButton());
    assert.ok(await waitFor(() => testId("motor-direction-error") !== null, 1500));
    assert.equal(testId("motor-direction-error"), "No controller reply: serial timeout: no reply within 1000 ms");
    assert.equal(testId("motor-direction-fc-line"), null, "a transport error is not an FC refusal (R5/R11)");
    assert.deepEqual(t.ops.slice(before), ["set motor_direction props-in", "get motor_direction", "mixer"], "set sent once (it may have reached the FC), then get -> mixer");
    assert.ok(Date.now() - t0 < 2 * MOTOR_DIRECTION_GATE_DELAY_MS + 500, `no retry delay: ${Date.now() - t0} ms`);
    assert.equal(held(), "props-out");
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: gate busy for every try -> 'unknown' + the gate's message, not older FC (QA #60)", async () => {
    const t = await gatedHost("props-out");
    const poll = t.holdGate();
    const root = mountPanel(t.host);
    const budget = MOTOR_DIRECTION_GATE_ATTEMPTS * MOTOR_DIRECTION_GATE_DELAY_MS + 1500;
    assert.ok(await waitFor(() => testId("motor-direction-busy") !== null, budget), `exhausted state shown: ${held()} refused=${t.refused.length}`);
    assert.equal(testId("motor-direction-busy"), GATE_BUSY_MESSAGE);
    assert.equal(held(), "unknown");
    assert.equal(testId("motor-direction-old-fc"), null, "not the older-FC banner");
    assert.ok(isDisabled(select()) && isDisabled(setButton()));
    assert.equal(count(t.refused, "get motor_direction"), MOTOR_DIRECTION_GATE_ATTEMPTS, "bounded: exactly MOTOR_DIRECTION_GATE_ATTEMPTS tries");
    assert.ok(!t.ops.includes("get motor_direction") && !t.ops.includes("mixer"));
    assert.equal(testId("motor-direction-fc-line"), null, "busy is never in the FC refusal slot");
    poll.release(); await poll.done;
    await sleep(3 * MOTOR_DIRECTION_GATE_DELAY_MS);
    assert.equal(held(), "unknown", "no automatic re-read after the retries ran out");
    assert.ok(!isDisabled(readAgain()), "Read again offered (R3)");
    await click(readAgain());
    assert.ok(await waitFor(() => held() === "props-out" && !isDisabled(select()), 1500), `Read again recovers: ${held()}`);
    assert.equal(testId("motor-direction-busy"), null);
    assert.deepEqual(t.ops.filter(notPoll), ["get motor_direction", "mixer"]);
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: a set refused by the busy gate for every try -> busy state, never the FC refusal slot (R5)", async () => {
    const t = await gatedHost("props-out");
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out"));
    await choose("props-in");
    const before = t.ops.length;
    const poll = t.holdGate();
    await click(setButton());
    const budget = 2 * MOTOR_DIRECTION_GATE_ATTEMPTS * MOTOR_DIRECTION_GATE_DELAY_MS + 1500; // set tries, then the get re-read tries
    assert.ok(await waitFor(() => testId("motor-direction-busy") !== null, budget), "busy shown");
    assert.equal(testId("motor-direction-busy"), GATE_BUSY_MESSAGE);
    assert.equal(testId("motor-direction-fc-line"), null, "gate busy is not an FC refusal");
    assert.ok(!t.ops.slice(before).includes("set motor_direction props-in"), "the set never reached the FC");
    poll.release(); await poll.done;
    root.unmount(); await t.mock.disconnect();
  });

  await test("real gate: unmount stops the retries (nothing sent afterwards) (QA #60)", async () => {
    const t = await gatedHost("props-out");
    const poll = t.holdGate();
    const root = mountPanel(t.host);
    assert.ok(await waitFor(() => count(t.refused, "get motor_direction") >= 2, 1000));
    root.unmount();
    const tries = count(t.refused, "get motor_direction");
    await sleep(3 * MOTOR_DIRECTION_GATE_DELAY_MS);
    poll.release(); await poll.done;
    await sleep(3 * MOTOR_DIRECTION_GATE_DELAY_MS);
    assert.ok(count(t.refused, "get motor_direction") <= tries, `no retry after unmount: ${tries} -> ${count(t.refused, "get motor_direction")}`);
    assert.ok(!t.ops.includes("get motor_direction") && !t.ops.includes("mixer"), `nothing sent after unmount: ${JSON.stringify(t.ops)}`);
    await t.mock.disconnect();
  });

  // ---- #63: the REAL ProtocolHostAdapter (createHost via HostProvider) over the protocol MockSerial ----
  /** HostProvider + MotorsPage with the real useHost (the runner's stub delegates when __setupTestHost === "real").
   * Every host command is logged in `ops` ("version" for getVersion, "status" for getStatus; see the try: prefix); `connect()` does what
   * ConnectPage does: host.connect, then pollAfterConnect. `patch` may wrap host methods before anything runs. */
  async function realPage(path = "mock://bobflight", patch?: (h: Record<string, unknown>) => void) {
    (globalThis as Record<string, unknown>).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    (globalThis as Record<string, unknown>).__setupTestHost = "real";
    let api: ReturnType<typeof realUseHost> | null = null;
    function Grab() { api = realUseHost(); return null; }
    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<HostProvider><Grab /><MotorsPage /></HostProvider>));
    assert.ok(await waitFor(() => api !== null && !!panel()));
    const host = api!.host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const ops: string[] = [];
    for (const [name, label] of [["sendCommand", null], ["getVersion", "version"], ["getStatus", "status"]] as const) {
      const orig = host[name].bind(host);
      // "try:<cmd>" for every call (also the gate's busy refusals), "<cmd>" once the call settled past the gate.
      host[name] = async (...a: unknown[]) => {
        const op = label ?? String(a[0]);
        ops.push(`try:${op}`);
        try { const r = await orig(...a); ops.push(op); return r; } catch (e) { if (!isGateBusy(e)) ops.push(op); throw e; }
      };
    }
    patch?.(host as unknown as Record<string, unknown>);
    const connect = async () => {
      await (host.connect as (o: unknown) => Promise<void>)({ path, baudRate: 115200 });
      ops.push("<connect resolved>");
      // In the app the Connect tab runs pollAfterConnect while Motors is unmounted; here both are mounted,
      // so the page's own poll can hold the gate: retry only the gate's busy refusal.
      for (let i = 0; ; i++) {
        try { await api!.pollAfterConnect(); break; } catch (e) { if (!isGateBusy(e) || i > 60) throw e; await sleep(50); }
      }
      ops.push("<polled>");
    };
    return {
      host, ops, connect, api: () => api!,
      done: async () => { root.unmount(); await sleep(30); try { await (host.disconnect as () => Promise<void>)(); } catch { /* already */ } delete (globalThis as Record<string, unknown>).__setupTestHost; delete (globalThis as Record<string, unknown>).document; },
    };
  }

  await test("real MotorsPage: background telemetry does not flicker controls or swallow clicks", async () => {
    let holdNext = false, reached = () => {}, release = () => {};
    const reachedRead = new Promise<void>(r => { reached = r; });
    const heldRead = new Promise<void>(r => { release = r; });
    const t = await realPage("mock://bobflight-bench", h => {
      const send = h.sendCommand as (c: string) => Promise<unknown>;
      h.sendCommand = async (cmd: string) => {
        if (holdNext && cmd === "get erpm_m1") { holdNext = false; reached(); await heldRead; }
        return send(cmd);
      };
    });
    try {
      await t.connect();
      const box = (text: string) => container.findAll(e => e.tagName === "LABEL" && visibleText(e).includes(text))[0].findAll(e => e.tagName === "INPUT")[0];
      const button = (text: string) => container.findAll(e => e.tagName === "BUTTON" && visibleText(e).startsWith(text))[0];
      assert.ok(await waitFor(() => !isDisabled(box("every motor is stationary")), 3000));
      flushSync(() => reactProps(box("All props are removed")).onChange({ target: { checked: true } }));
      flushSync(() => reactProps(box("every motor is stationary")).onChange({ target: { checked: true } }));
      const slider = container.findAll(e => e.tagName === "INPUT" && e.getAttribute("id") === "motor-level-1")[0];
      assert.ok(await waitFor(() => !isDisabled(slider), 3000), "pulse capability initialized");
      flushSync(() => reactProps(slider).onChange({ target: { value: "5" } }));
      assert.ok(await waitFor(() => !isDisabled(button("Run sequence")) && !isDisabled(button("DShot600")), 3000));
      holdNext = true; await reachedRead; await sleep(0);
      for (let sample = 0; sample < 3; sample++) {
        assert.ok(!isDisabled(box("every motor is stationary")), "stationary checkbox remains usable during read");
        assert.ok(!isDisabled(button("DShot600")), "available rate remains enabled during read");
        assert.ok(isDisabled(button("DShot300")), "already selected rate stays disabled");
        assert.ok(!isDisabled(button("Run sequence")), "sequence remains enabled during read");
        assert.ok(!isDisabled(button("Test M1")), "prepared pulse remains enabled during read");
        await sleep(10);
      }
      flushSync(() => reactProps(box("every motor is stationary")).onChange({ target: { checked: false } }));
      assert.ok(isDisabled(button("Run sequence")), "real acknowledgement gate still applies");
      flushSync(() => reactProps(box("every motor is stationary")).onChange({ target: { checked: true } }));
      assert.ok(!isDisabled(button("Run sequence")), "acknowledgement is not swallowed during polling");
      await click(button("DShot600"));
      assert.ok(isDisabled(button("Run sequence")) && isDisabled(box("every motor is stationary")), "actual pending action locks controls");
      assert.ok(!t.ops.includes("dshot 600"), "no overlapping write while read outstanding");
      release();
      assert.ok(await waitFor(() => t.ops.includes("dshot 600") && !isDisabled(button("DShot300")), 3000), "click during poll is executed with readback");
      assert.ok(!t.ops.some(op => /^(motor_seq|motor_pulse |motor_test [1-4])/.test(op)), "no motor command without explicit motor request");
    } finally { release(); await t.done(); }
  });

  await test("real adapter: disconnected -> 'Locked: not connected.', no command sent by the panel", async () => {
    const t = await realPage();
    await sleep(80);
    assert.equal(held(), "not connected");
    assert.equal(lockLine(), "Locked: not connected.");
    assert.ok(isDisabled(select()) && isDisabled(setButton()) && isDisabled(readAgain()));
    assert.ok(!t.ops.some((op) => /^(try:)?get motor_direction$/.test(op)), JSON.stringify(t.ops));
    await t.done();
  });

  await test("real adapter: connect and reconnect -> get only after pollAfterConnect read the version, value verbatim (R14)", async () => {
    const t = await realPage();
    for (const round of [1, 2]) {
      const start = t.ops.length;
      await t.connect();
      assert.ok(await waitFor(() => held() === "props-out" && mixerCells().mixer === "props-out", 4000), `round ${round}: ${held()} ${JSON.stringify(t.ops.slice(start))}`);
      const ops = t.ops.slice(start);
      const iGet = ops.indexOf("try:get motor_direction");
      assert.ok(iGet > ops.indexOf("version") && ops.indexOf("version") > ops.indexOf("<connect resolved>"), `round ${round}: first get attempt only after the host connect completed and the version was read: ${JSON.stringify(ops)}`);
      assert.equal(count(ops, "get motor_direction"), 1, `round ${round}: one get`);
      assert.deepEqual(mixerCells().yaw, OUT_YAW);
      assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select()), 3000), `round ${round}: unlocked: ${lockLine()}`);
      await (t.host.disconnect as () => Promise<void>)();
      assert.ok(await waitFor(() => held() === "not connected" && lockLine() === "Locked: not connected."), `round ${round}: cleared: ${held()}`);
      assert.equal(row("Mixer reports"), null);
    }
    await t.done();
  });

  await test("real adapter: armed (status arm: armed) and unknown arm lock the selector; set and get still verbatim", async () => {
    const arm: { v: string | undefined | "keep" } = { v: "keep" };
    const t = await realPage("mock://bobflight", (h) => {
      const orig = (h.getStatus as () => Promise<Record<string, unknown>>);
      h.getStatus = async () => { const s = await orig(); return arm.v === "keep" ? s : { ...s, arm: arm.v }; };
    });
    await t.connect();
    assert.ok(await waitFor(() => held() === "props-out" && lockLine() === null && !isDisabled(select()), 4000), String(lockLine()));
    await choose("props-in");
    arm.v = "armed";
    assert.ok(await waitFor(() => lockLine() === "Locked: the controller reports arm: armed (must be disarmed).", 3000), String(lockLine()));
    await assertLockedNoSet(t, "real armed");
    arm.v = undefined;
    assert.ok(await waitFor(() => lockLine() === "Locked: arming state unknown (the controller must report arm: disarmed).", 3000), String(lockLine()));
    await assertLockedNoSet(t, "real unknown arm");
    arm.v = "keep";
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select()), 3000));
    await t.done();
  });

  await test("real adapter: StoragePanel refresh pending locks the selector until it settles", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const t = await realPage("mock://bobflight", (h) => {
      const orig = h.sendCommand as (c: string) => Promise<string>;
      h.sendCommand = async (c: string) => { if (c === "storage") await gate; return orig(c); };
    });
    await t.connect();
    assert.ok(await waitFor(() => held() === "props-out" && lockLine() === "Locked while a controller storage action (save, refresh or export) is pending.", 4000), String(lockLine()));
    await assertLockedNoSet(t, "real storage pending");
    release();
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select()), 3000), String(lockLine()));
    await t.done();
  });

  await test("real adapter (bench mock): a page motor test locks the selector; the FW refusal is the backstop", async () => {
    const t = await realPage("mock://bobflight-bench");
    await t.connect();
    assert.ok(await waitFor(() => held() === "props-out" && lockLine() === null && !isDisabled(select()), 4000), String(lockLine()));
    await choose("props-in");
    const box = (text: string) => container.findAll((e) => e.tagName === "LABEL" && visibleText(e).includes(text))[0].findAll((e) => e.tagName === "INPUT")[0];
    flushSync(() => reactProps(box("All props are removed")).onChange({ target: { checked: true } }));
    assert.ok(await waitFor(() => !isDisabled(box("every motor is stationary")), 3000));
    flushSync(() => reactProps(box("every motor is stationary")).onChange({ target: { checked: true } }));
    const slider = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("id") === "motor-level-1")[0];
    assert.ok(await waitFor(() => !isDisabled(slider), 3000), "slider enabled");
    flushSync(() => reactProps(slider).onChange({ target: { value: "5" } }));
    const testBtn = () => container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).startsWith("Test M1"))[0];
    assert.ok(await waitFor(() => !isDisabled(testBtn()), 3000), `Test M1 enabled: ${visibleText(container as unknown as FakeElement).match(/role|Confirm|Waiting|Four|Visually|Controller must[^.]*/)?.[0]}`);
    await click(testBtn());
    assert.ok(await waitFor(() => t.ops.includes("motor_pulse 1 5"), 3000), JSON.stringify(t.ops.slice(-8)));
    assert.ok(await waitFor(() => lockLine() === "Locked while a motor test runs.", 1000), `inside the test window: ${lockLine()}`);
    await assertLockedNoSet(t, "motor test");
    let fw = "";
    for (let i = 0; ; i++) {
      try { fw = await (t.host.sendCommand as (c: string) => Promise<string>)("set motor_direction props-in"); break; }
      catch (e) { if (!isGateBusy(e) || i > 20) throw e; await sleep(20); }
    }
    assert.equal(fw.trim(), "set failed: motor test running", "FW refuses during the test (backstop)");
    assert.ok(await waitFor(() => lockLine() === null && !isDisabled(select()), 4000), `unlocks after the test window: ${lockLine()}`);
    await t.done();
  });

  console.log(failed ? `FAIL motor direction render: ${failed} failed, ${passed} passed` : `PASS motor direction render: ${passed} tests`);
  process.exit(failed ? 1 : 0);
}
const guard = setTimeout(() => { console.log("FAIL timeout"); process.exit(1); }, 150000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.log("FAIL harness"); console.error(e); process.exit(1); });
