/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * P1 (persistence audit fix 1 of 5): CommandGate bounded priority FIFO.
 *
 * 1. The real CommandGate: priority classes (urgent > write > normal), stable
 *    FIFO within a class, overflow -> the gate's busy error, per-command queue
 *    timeout from enqueue, AbortSignal cancel, drain("disconnected"), motor
 *    starts never queued.
 * 2. The REAL ProtocolHostAdapter (createHost test seam) + REAL
 *    BobFlightCliClient over a simulated FC with USB latency: concurrent reads
 *    all succeed with one command on the wire, priority / overflow / timeout /
 *    cancel / disconnect end to end.
 * 3. M1 repro (audit motors-race): the real MotorsPage + StoragePanel +
 *    poles/direction panels over that adapter at RTT 10 and 50 ms. Before P1
 *    "Save to controller" was disabled 100% of the time; it must now be 0%,
 *    with zero gate refusals, the props checkbox never cleared (M2) and one
 *    storage read at mount (M4: no re-key on rate).
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FakeFc, FakeFcTransportFactory } from "./fixtures/fakeFcTransport";
import { MotorsPage } from "../src/pages/MotorsPage";
import { createHost } from "../src/protocol/createHost";
import {
  CommandGate, commandGateOptions, isGateBusy, isGateNotSent, GateBusyError, GateQueueTimeoutError, GateCancelledError,
  GATE_BUSY_MESSAGE, GATE_START_BUSY_MESSAGE, GATE_DISCONNECTED_MESSAGE, GATE_QUEUE_LIMIT, GATE_QUEUE_TIMEOUT_MS,
} from "../src/protocol/commandGate";
import type { BobFlightHost, CliCommand } from "../src/protocol/types";
import { STORAGE_ACTIVITY_HOLD_MS } from "../src/protocol/storageActivity";
import {
  GateError, GateDisconnectedError, GateSessionChangedError, gateErrorCode, GATE_ERROR_CODES, isReadOnlyCliCommand,
  type GateErrorCode,
} from "../src/protocol/commandGate";
import * as uiProtocol from "../src/protocol";
import { ALLOWED_CLI_COMMANDS } from "../src/protocol/types";
import { SdGateBusyError } from "@bobflight/protocol";
import { BenchController } from "../src/motors/benchController";
import { StoragePanel } from "../src/components/StoragePanel";
import { readRpmKey, readRpmReport, readRpm, rpmView } from "../src/filters/rpmFilter";
import { readNotches, notchesSupported } from "../src/filters/gyroNotch";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function deferred<T = void>() { let resolve!: (t: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let passed = 0;
const only = process.env.ONLY;
async function test(name: string, fn: () => Promise<void> | void) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`PASS ${name}`); }
const settle = <T,>(p: Promise<T>) => p.then(v => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ---- 1. the real CommandGate ---------------------------------------------------
async function gateTests() {
  await test("gate: one at a time; urgent (Stop) > write (save/set) > normal (reads); FIFO within a class", async () => {
    const gate = new CommandGate(() => 1);
    const hold = deferred<string>(); const order: string[] = []; let running = 0, maxRunning = 0;
    const job = (name: string) => async () => { running++; maxRunning = Math.max(maxRunning, running); order.push(name); await sleep(1); running--; return name; };
    const first = gate.run(async () => { order.push("held"); return hold.promise; });
    await ticks();
    const all = [
      gate.run(job("read1")), gate.run(job("read2")), gate.run(job("save1"), { priority: "write" }),
      gate.run(job("stop1"), true), gate.run(job("read3")), gate.run(job("set1"), commandGateOptions("set motor_poles 14")),
      gate.run(job("stop2"), commandGateOptions("motor_test 0")), gate.run(job("save2"), commandGateOptions("save")),
    ];
    assert.equal(gate.queued, 8);
    hold.resolve("held"); await first; await Promise.all(all);
    assert.deepEqual(order, ["held", "stop1", "stop2", "save1", "set1", "save2", "read1", "read2", "read3"]);
    assert.equal(maxRunning, 1, "never two commands at once");
  });
  await test("gate: classification of exact CLI lines", () => {
    for (const c of ["motor_test 0", "bench_stop", "disarm"]) assert.equal(commandGateOptions(c).priority, "urgent", c);
    for (const c of ["save", "defaults", "set motor_poles 14", "set dshot_bidir on"]) assert.equal(commandGateOptions(c).priority, "write", c);
    for (const c of ["status", "storage", "get erpm_m1", "dshot", "mixer", "dump all"]) assert.equal(commandGateOptions(c).priority, "normal", c);
    for (const c of ["arm", "motor_seq", "motor_test 1", "motor_test 4", "motor_pulse 2 30", "bench_switch"]) assert.equal(commandGateOptions(c).exclusive, true, c);
  });
  await test("gate: overflow refuses with the existing busy error (never silent); Stop still accepted when full", async () => {
    assert.equal(GATE_QUEUE_LIMIT, 16);
    const gate = new CommandGate(() => 1);
    const hold = deferred<string>(); const ran: number[] = [];
    const first = gate.run(() => hold.promise); await ticks();
    const queued = Array.from({ length: 16 }, (_, i) => gate.run(async () => { ran.push(i); return i; }));
    const over = await settle(gate.run(async () => { ran.push(99); return 99; }));
    assert.equal(over.ok, false);
    assert.ok(!over.ok && isGateBusy(over.e) && over.e instanceof GateBusyError && over.e instanceof Error);
    assert.equal(!over.ok && (over.e as Error).message, GATE_BUSY_MESSAGE);
    assert.match(GATE_BUSY_MESSAGE, /^busy, queue full/);
    // Older callers match the pre-queue wording: keep them honest.
    assert.match(GATE_BUSY_MESSAGE, /another UI command is in flight/); assert.match(GATE_BUSY_MESSAGE, /request not queued/);
    const overWrite = await settle(gate.run(async () => 0, { priority: "write" }));
    assert.ok(!overWrite.ok && isGateBusy(overWrite.e), "write also bounded");
    const stop = gate.run(async () => "stop", true);
    assert.equal(gate.queued, 17, "urgent is never refused by the bound");
    hold.resolve("x"); await first;
    assert.equal(await stop, "stop");
    assert.deepEqual(await Promise.all(queued), [...Array(16).keys()]);
    assert.ok(!ran.includes(99));
  });
  await test("gate: motor starts are never queued (refused while busy, run on an idle gate)", async () => {
    const gate = new CommandGate(() => 1);
    assert.equal(await gate.run(async () => "start", commandGateOptions("motor_test 1")), "start", "idle gate runs it");
    const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    let ran = false;
    const r = await settle(gate.run(async () => { ran = true; return "x"; }, commandGateOptions("motor_pulse 1 50")));
    assert.ok(!r.ok && isGateBusy(r.e) && (r.e as Error).message === GATE_START_BUSY_MESSAGE);
    hold.resolve("x"); await first; await sleep(5);
    assert.equal(ran, false, "a refused start never fires later");
  });
  await test("gate: each queued command has its own timeout measured from enqueue; nothing sent", async () => {
    const gate = new CommandGate(() => 1, 16, 120);
    const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    const t0 = Date.now(); let ran = 0;
    const a = settle(gate.run(async () => { ran++; return "a"; })).then(r => ({ r, at: Date.now() - t0 }));
    await sleep(60);
    const b = settle(gate.run(async () => { ran++; return "b"; })).then(r => ({ r, at: Date.now() - t0 }));
    const c = settle(gate.run(async () => { ran++; return "c"; }, { timeoutMs: 1000 }));
    const ra = await a, rb = await b;
    assert.ok(!ra.r.ok && ra.r.e instanceof GateQueueTimeoutError && isGateNotSent(ra.r.e));
    assert.ok(!rb.r.ok && rb.r.e instanceof GateQueueTimeoutError);
    assert.ok(ra.at >= 110 && ra.at < 175, `a timed out ~120 ms after its enqueue (${ra.at})`);
    assert.ok(rb.at >= 170 && rb.at < 240, `b timed out ~120 ms after its own enqueue, not a's (${rb.at})`);
    assert.equal(gate.queued, 1, "only c (longer timeout) still waits");
    hold.resolve("x"); await first;
    const rc = await c; assert.ok(rc.ok && rc.v === "c");
    assert.equal(ran, 1, "timed-out commands never ran");
    assert.equal(GATE_QUEUE_TIMEOUT_MS, 5000);
  });
  await test("gate: AbortSignal cancel drops the queued command; order of the rest preserved", async () => {
    const gate = new CommandGate(() => 1);
    const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    const order: string[] = []; const ac = new AbortController();
    const a = gate.run(async () => { order.push("a"); });
    const b = settle(gate.run(async () => { order.push("b"); }, { signal: ac.signal }));
    const c = gate.run(async () => { order.push("c"); });
    ac.abort();
    const rb = await b;
    assert.ok(!rb.ok && rb.e instanceof GateCancelledError && isGateNotSent(rb.e));
    assert.equal(gate.queued, 2);
    const pre = await settle(gate.run(async () => { order.push("pre"); }, { signal: ac.signal }));
    assert.ok(!pre.ok && pre.e instanceof GateCancelledError, "already-aborted signal is refused up front");
    hold.resolve("x"); await first; await a; await c;
    assert.deepEqual(order, ["a", "c"]);
  });
  await test("gate: drain('disconnected') rejects everything queued; the command on the wire settles itself", async () => {
    let session = 1; const gate = new CommandGate(() => session);
    const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    let ran = 0;
    const q = [gate.run(async () => { ran++; }), gate.run(async () => { ran++; }, true), gate.run(async () => { ran++; }, { priority: "write" })].map(settle);
    gate.drain();
    for (const r of await Promise.all(q)) assert.ok(!r.ok && (r.e as Error).message === GATE_DISCONNECTED_MESSAGE && isGateNotSent(r.e));
    assert.equal(gate.queued, 0);
    hold.resolve("on-wire"); assert.equal(await first, "on-wire");
    // A command queued in one session is never sent in the next (unchanged rule).
    const hold2 = deferred<string>(); const f2 = gate.run(() => hold2.promise); await ticks();
    const stale = settle(gate.run(async () => { ran++; }));
    session++; hold2.resolve("x"); await f2;
    const rs = await stale; assert.ok(!rs.ok && /session changed/.test((rs.e as Error).message));
    assert.equal(ran, 0);
  });
}

// ---- 2. real adapter + real client over a simulated FC ------------------------
async function adapterRig(rttMs = 5) {
  const fc = new FakeFc({ rttMs });
  const host = createHost("serial", new FakeFcTransportFactory(fc));
  await host.connect({ path: "sim://fake-fc", transport: "serial" } as never);
  assert.equal(host.getConnectionStatus(), "connected");
  return { fc, host, mark: () => fc.log.length };
}
async function adapterTests() {
  await test("adapter: concurrent poll + storage read + panel reads all succeed, one command on the wire, call order kept", async () => {
    const { fc, host } = await adapterRig(5);
    const cmds: CliCommand[] = ["storage", "get motor_poles", "get motor_direction", "dshot", "get erpm_m1", "get erpm_m2", "get erpm_m3", "get erpm_m4", "mixer", "rpm_filter"];
    const results = await Promise.all([settle(host.getStatus()), ...cmds.map(c => settle(host.sendCommand(c)))]);
    for (const [i, r] of results.entries()) assert.ok(r.ok, `${i === 0 ? "status" : cmds[i - 1]}: ${r.ok ? "" : String(r.e)}`);
    assert.equal(fc.overlaps, 0, "the FC never saw two commands at once");
    assert.deepEqual(fc.log, ["status", ...cmds], "same-priority commands keep call order");
    await host.disconnect();
  });
  await test("adapter: Stop and save jump ahead of queued reads; set (write) after save; reads FIFO", async () => {
    const { fc, host, mark } = await adapterRig(2);
    const release = fc.hold("status"); const m = mark();
    const status = host.getStatus(); await sleep(5);
    const reads = [host.sendCommand("get motor_direction"), host.sendCommand("storage"), host.sendCommand("dshot")];
    const save = host.saveSettings();
    const set = host.sendCommand("set motor_poles 14");
    const stop = host.sendCommand("motor_test 0");
    await sleep(10); release();
    await Promise.all([status, ...reads, save, set, stop]);
    assert.deepEqual(fc.log.slice(m), ["status", "motor_test 0", "storage", "save", "storage", "set motor_poles 14", "get motor_direction", "storage", "dshot"]);
    assert.equal(fc.overlaps, 0);
    await host.disconnect();
  });
  await test("adapter: overflow -> the gate's busy error (isGateBusy); Stop accepted; queued ones still succeed", async () => {
    const { fc, host, mark } = await adapterRig(1);
    const release = fc.hold("status"); const m = mark();
    const status = host.getStatus(); await sleep(5);
    const queued = Array.from({ length: GATE_QUEUE_LIMIT }, () => host.sendCommand("dshot"));
    const over = await settle(host.sendCommand("storage"));
    assert.ok(!over.ok && isGateBusy(over.e) && (over.e as Error).message === GATE_BUSY_MESSAGE);
    assert.equal(host.getLastError(), GATE_BUSY_MESSAGE, "surfaced, not silent");
    const stop = host.sendCommand("motor_test 0");
    release(); await status; await stop;
    for (const r of await Promise.all(queued)) assert.match(r, /dshot: 300 kbps/);
    assert.ok(!fc.log.slice(m).includes("storage"), "the refused command never reached the FC");
    assert.equal(fc.log.slice(m)[1], "motor_test 0");
    await host.disconnect();
  });
  await test("adapter: a queued command times out GATE_QUEUE_TIMEOUT_MS after its own enqueue; never sent", async () => {
    const { fc, host, mark } = await adapterRig(1);
    // `save` has the client's long (15 s) wire timeout, so it can hold the wire past the queue deadline.
    const release = fc.hold("save"); const m = mark();
    const status = settle(host.saveSettings()); await sleep(20);
    assert.equal(fc.log.at(-1), "save", "save is on the wire");
    const t0 = Date.now();
    const a = settle(host.sendCommand("storage")).then(r => ({ r, at: Date.now() - t0 }));
    await sleep(300);
    const b = settle(host.sendCommand("mixer")).then(r => ({ r, at: Date.now() - t0 }));
    const ra = await a, rb = await b;
    assert.ok(!ra.r.ok && ra.r.e instanceof GateQueueTimeoutError, String(!ra.r.ok && ra.r.e));
    assert.ok(!rb.r.ok && rb.r.e instanceof GateQueueTimeoutError);
    assert.ok(ra.at >= GATE_QUEUE_TIMEOUT_MS - 10 && ra.at < GATE_QUEUE_TIMEOUT_MS + 150, `a at ${ra.at}`);
    assert.ok(rb.at >= GATE_QUEUE_TIMEOUT_MS + 290 && rb.at < GATE_QUEUE_TIMEOUT_MS + 450, `b at ${rb.at} (own deadline)`);
    release(); assert.ok((await status).ok, "the held save itself completes");
    assert.deepEqual(fc.log.slice(m), ["storage", "save", "storage"], "timed-out commands never reached the FC");
    await host.disconnect();
  });
  await test("adapter: caller cancel (AbortSignal) drops a queued command; nothing sent", async () => {
    const { fc, host, mark } = await adapterRig(1);
    const release = fc.hold("status"); const m = mark();
    const status = host.getStatus(); await sleep(5);
    const ac = new AbortController();
    const storage = settle(host.sendCommand("storage", { signal: ac.signal }));
    const after = host.sendCommand("dshot");
    ac.abort();
    const r = await storage; assert.ok(!r.ok && r.e instanceof GateCancelledError);
    release(); await status; await after;
    assert.deepEqual(fc.log.slice(m), ["status", "dshot"]);
    await sleep(STORAGE_ACTIVITY_HOLD_MS + 20);
    assert.equal(host.storageActionPending!(), false, "a cancelled storage read does not leave the storage lock set");
    await host.disconnect();
  });
  await test("adapter: disconnect rejects everything queued with 'disconnected'; nothing replayed after reconnect", async () => {
    const { fc, host, mark } = await adapterRig(1);
    const release = fc.hold("status"); const m = mark();
    const status = settle(host.getStatus()); await sleep(5);
    const queued = [host.sendCommand("storage"), host.saveSettings(), host.sendCommand("motor_test 0"), host.getSetting("motor_poles" as never)].map(p => settle(p as Promise<unknown>));
    await host.disconnect();
    for (const r of await Promise.all(queued)) assert.ok(!r.ok && (r.e as Error).message === GATE_DISCONNECTED_MESSAGE, String(!r.ok && r.e));
    release(); await status;
    await host.connect({ path: "sim://fake-fc", transport: "serial" } as never);
    await sleep(50);
    assert.deepEqual(fc.log.slice(m), ["status"], "queued commands never reached the FC, in this or the next session");
    await sleep(STORAGE_ACTIVITY_HOLD_MS + 20);
    assert.equal(host.storageActionPending!(), false);
    await host.disconnect();
  });
}

// ---- 3. M1 repro: real MotorsPage over the real adapter -------------------------
const { container } = installFakeDom();
const g = globalThis as Record<string, any>;
g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
g.window.confirm = () => true;
g.URL.createObjectURL = () => "blob:x";
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
const text = (n: FakeElement): string => n.childNodes.map((c: any) => isEl(c) ? text(c) : c.textContent).join("");
const find = (pred: (e: FakeElement) => boolean) => container.findAll(pred);
const btn = (label: RegExp) => find(e => e.tagName === "BUTTON" && label.test(text(e)))[0];
const dis = (e?: FakeElement) => !e ? null : (e.disabled || e.hasAttribute("disabled"));
const props = (e: FakeElement): any => (e as any)[Object.keys(e).find(k => k.startsWith("__reactProps$"))!];
const checkboxes = () => find(e => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox");


// ---- 4. #99 review round 1 ---------------------------------------------------------
const URGENT = new Set(["motor_test 0", "bench_stop", "disarm"]);
/** Lines that reached the FC after `t` (request time) and before `cmd` did. */
function sentBetween(fc: FakeFc, t: number, cmd = "motor_test 0") {
  const w = fc.wire.find(x => x.cmd === cmd && x.at >= t);
  return { stop: w, delay: w ? w.at - t : Infinity, between: fc.wire.filter(x => x.at >= t && w && x.at <= w.at && x !== w).map(x => x.cmd) };
}
async function waitWire(fc: FakeFc, cmd: string, after: number, ms = 8000) {
  for (let i = 0; i < ms / 5 && !fc.wire.some(x => x.cmd === cmd && x.at >= after); i++) await sleep(5);
}
async function round1GateTests() {
  await test("gate r1: every error kind has a stable code + predicates; text changes never affect them", async () => {
    const kinds: Array<[Error, GateErrorCode, boolean]> = [
      [new GateBusyError(), "GATE_QUEUE_FULL", true],
      [new GateBusyError(GATE_START_BUSY_MESSAGE, "GATE_BUSY_START"), "GATE_BUSY_START", true],
      [new GateQueueTimeoutError(5000), "GATE_QUEUE_TIMEOUT", false],
      [new GateCancelledError(), "GATE_CANCELLED", false],
      [new GateDisconnectedError(), "GATE_DISCONNECTED", false],
      [new GateSessionChangedError(), "GATE_SESSION_CHANGED", false],
    ];
    assert.deepEqual(kinds.map(k => k[1]).sort(), [...GATE_ERROR_CODES].sort(), "every code covered");
    for (const [e, code, busy] of kinds) {
      assert.ok(e instanceof GateError && e instanceof Error, code);
      assert.equal((e as GateError).code, code); assert.equal(gateErrorCode(e), code);
      assert.equal(isGateBusy(e), busy, `${code} isGateBusy`); assert.equal(isGateNotSent(e), true, `${code} isGateNotSent`);
      // Same code, different (future) UI text: predicates unchanged.
      const reworded = Object.assign(new Error("some reworded copy"), { gate: true, code });
      assert.equal(isGateBusy(reworded), busy); assert.equal(isGateNotSent(reworded), true); assert.equal(gateErrorCode(reworded), code);
      // Same text without the code (an FC reply / client error that happens to read the same): never a gate error.
      const lookalike = new Error(e.message);
      assert.equal(isGateBusy(lookalike), false, `text alone is not ${code}`); assert.equal(isGateNotSent(lookalike), false);
    }
    assert.equal(new GateBusyError(GATE_START_BUSY_MESSAGE).code, "GATE_BUSY_START", "start text defaults to the start code");
    assert.match(GATE_START_BUSY_MESSAGE, /^busy, try again/); assert.doesNotMatch(GATE_START_BUSY_MESSAGE, /queue full/);
    assert.match(GATE_BUSY_MESSAGE, /^busy, queue full/);
    for (const e of [new Error("CLI command timed out with empty response"), new Error("disconnected"), new Error("not connected"), "x", null, undefined])
      assert.ok(!isGateNotSent(e) && !isGateBusy(e) && gateErrorCode(e) === null, String(e));
    // The protocol sd-read wrapper keeps the code, so the UI predicate still sees a busy refusal.
    const sd = new SdGateBusyError(GATE_START_BUSY_MESSAGE, "GATE_BUSY_START");
    assert.ok(isGateBusy(sd) && gateErrorCode(sd) === "GATE_BUSY_START");
    // Public surface: exported from the ui protocol index.
    for (const name of ["GateError", "GateBusyError", "GateQueueTimeoutError", "GateCancelledError", "GateDisconnectedError", "GateSessionChangedError", "isGateBusy", "isGateNotSent", "gateErrorCode", "GATE_ERROR_CODES"])
      assert.ok(name in uiProtocol, `ui protocol index exports ${name}`);
  });
  await test("gate r1: motor starts AND bench_switch refused 'busy, try again' (GATE_BUSY_START, isGateBusy) on a busy gate", async () => {
    const gate = new CommandGate(() => 1); const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    let ran = 0;
    for (const c of ["arm", "motor_seq", "motor_test 1", "motor_pulse 3 40", "bench_switch"]) {
      const r = await settle(gate.run(async () => { ran++; return c; }, commandGateOptions(c)));
      assert.ok(!r.ok && isGateBusy(r.e) && isGateNotSent(r.e) && gateErrorCode(r.e) === "GATE_BUSY_START" && r.e instanceof GateBusyError, c);
      assert.equal((r.e as Error).message, GATE_START_BUSY_MESSAGE);
    }
    hold.resolve("x"); await first; await sleep(5);
    assert.equal(ran, 0, "never fired later");
    assert.equal(await gate.run(async () => "sw", commandGateOptions("bench_switch")), "sw", "idle gate runs bench_switch");
  });
  await test("gate r1: urgent never gets a queue timeout (G7), normal does", async () => {
    const gate = new CommandGate(() => 1, 16, 40);
    const first = gate.run(() => sleep(150).then(() => "held")); await ticks();
    const read = settle(gate.run(async () => "read"));
    const stop = settle(gate.run(async () => "stop", commandGateOptions("motor_test 0")));
    const stop2 = settle(gate.run(async () => "stop2", true));
    const rr = await read; assert.ok(!rr.ok && gateErrorCode(rr.e) === "GATE_QUEUE_TIMEOUT", "normal timed out at 40 ms");
    await first;
    const rs = await stop, rs2 = await stop2;
    assert.ok(rs.ok && rs.v === "stop", `urgent waited past the 40 ms queue timeout: ${!rs.ok && String(rs.e)}`);
    assert.ok(rs2.ok && rs2.v === "stop2");
  });
  await test("gate r1: urgent goes out between the lines of a compound entry (yieldToUrgent); nothing else interleaves", async () => {
    const gate = new CommandGate(() => 1); const wire: string[] = []; let on = 0, maxOn = 0;
    const line = async (name: string) => { on++; maxOn = Math.max(maxOn, on); wire.push(name); await sleep(10); on--; };
    const compound = gate.run(async (y) => { for (let i = 1; i <= 5; i++) { await y(); await line(`get ${i}`); } return "all"; });
    await sleep(15); // `get 1` / `get 2` on the wire
    const read = gate.run(() => line("read"));
    const save = gate.run(() => line("save"), { priority: "write" });
    const stop = gate.run(() => line("stop"), true);
    const stop2 = gate.run(() => line("stop2"), commandGateOptions("disarm"));
    await Promise.all([compound, read, save, stop, stop2]);
    const i = wire.indexOf("stop");
    assert.ok(i > 0 && i < 4, `Stop right after the line on the wire: ${wire.join(",")}`);
    assert.equal(wire[i + 1], "stop2", "urgent FIFO");
    assert.deepEqual(wire.filter(w => w.startsWith("get")), ["get 1", "get 2", "get 3", "get 4", "get 5"], "compound order kept");
    assert.deepEqual(wire.slice(-2), ["save", "read"], "write/normal still wait for the whole compound entry");
    assert.equal(maxOn, 1, "one line on the wire at a time");
    // A finished entry's hook is inert (cannot run urgent outside its own turn).
    let late: (() => Promise<void>) | null = null;
    await gate.run(async (y) => { late = y; });
    const h = deferred<string>(); const f = gate.run(() => h.promise); await ticks();
    const u = gate.run(async () => { wire.push("u"); }, true);
    await late!(); assert.ok(!wire.includes("u"), "stale hook did not dispatch");
    h.resolve("x"); await f; await u; assert.equal(wire.at(-1), "u");
  });
  await test("gate r1: every state-changing CLI line is write class; reads normal; ordering vs a later save (item 2)", async () => {
    const writes = ["save", "defaults", "set motor_poles 14", "dshot 300", "dshot 600", "receiver_uart 3", "receiver_map AETR", "receiver_map TAER",
      "power_config 1 2 3 4 5 6 7", "calibrate_gyro", "calibrate_accel level", "calibrate_accel start", "calibrate_accel apply", "calibrate_accel cancel",
      "calibrate_accel +x", "calibrate_accel -z", "calibration_cancel", "mode_range ARM 1 5 1700 2100", "control_source manual", "control_source aux",
      "control_mode angle", "control_mode acro", "control_mode horizon", "blackbox start", "blackbox stop", "pid_diag start", "pid_diag start rx", "pid_diag stop",
      "sd cancel", "reboot", "bl", "bl discard", "set loop_rate_hz 4000", "set motor_direction props-in", "set dshot_bidir off", "set align_board_yaw 90",
      "set gyro_notch1_hz 200", "set rpm_filter_harmonics 2"];
    for (const c of writes) assert.equal(commandGateOptions(c).priority, "write", c);
    const reads = ["help", "ports", "modes", "storage", "diff all", "dump all", "version", "sd probe", "sd status", "sd read 12", "blackbox status", "status",
      "receiver", "pid_diag", "pid_diag status", "timing", "power", "bench_status", "barometer", "flash_info", "sensors", "calibration", "dshot",
      "get loop_rate_hz", "loop_rate", "get motor_direction", "mixer", "filters", "rpm_filter", "get erpm_m3", "get dshot_telem_m2", "get dshot_bidir", "get align_board_roll"];
    for (const c of reads) { assert.equal(commandGateOptions(c).priority, "normal", c); assert.ok(isReadOnlyCliCommand(c), c); }
    // Every fixed allowlisted line has a class, and only the known reads are normal.
    for (const c of ALLOWED_CLI_COMMANDS) {
      const o = commandGateOptions(c);
      const cls = o.exclusive ? "start" : o.priority;
      assert.ok(cls === "urgent" || cls === "start" || cls === "write" || (cls === "normal" && (reads.includes(c) || c.startsWith("get "))), `${c} -> ${cls}`);
    }
    assert.equal(commandGateOptions("some future line").priority, "write", "unknown lines default to write (fail-safe ordering)");
    // Ordering: queued state changes are never overtaken by a later save; reads wait behind both.
    const gate = new CommandGate(() => 1); const order: string[] = [];
    const hold = deferred<string>(); const first = gate.run(() => hold.promise); await ticks();
    const job = (c: string) => gate.run(async () => { order.push(c); }, commandGateOptions(c));
    const all = ["status", "dshot 600", "storage", "receiver_uart 3", "power_config 1 2 3 4 5 6 7", "calibrate_gyro", "mixer", "save"].map(job);
    hold.resolve("x"); await first; await Promise.all(all);
    assert.deepEqual(order, ["dshot 600", "receiver_uart 3", "power_config 1 2 3 4 5 6 7", "calibrate_gyro", "save", "status", "storage", "mixer"]);
  });
}

async function round1AdapterTests() {
  for (const [name, call] of [
    ["getAllSettings (30 gets, one entry)", (h: BobFlightHost) => h.getAllSettings()],
    ["restoreDefaults (defaults + 30 gets)", (h: BobFlightHost) => h.restoreDefaults()],
    ["saveSettings (storage, save, storage)", (h: BobFlightHost) => h.saveSettings()],
  ] as const) {
    await test(`adapter r1: Stop during ${name} at RTT 50 goes out after the reply on the wire (< 300 ms), nothing non-urgent first`, async () => {
      const { fc, host } = await adapterRig(50);
      const t0 = Date.now(); fc.t0 = t0; fc.wire = [];
      const compound = settle(call(host as BobFlightHost) as Promise<unknown>);
      const reads = ["storage", "get motor_poles", "mixer"].map(c => settle(host.sendCommand(c as CliCommand)));
      await sleep(130);
      const t = Date.now() - t0;
      const stop = settle(host.sendCommand("motor_test 0"));
      await waitWire(fc, "motor_test 0", t);
      const r = sentBetween(fc, t);
      console.log(`  stop during ${name}: ${JSON.stringify({ delayMs: r.delay, sentBetween: r.between })}`);
      assert.ok(r.delay < 300, `stop delay ${r.delay} ms`);
      assert.deepEqual(r.between.filter(c => !URGENT.has(c)), [], "nothing non-urgent between the Stop request and its send");
      assert.ok((await stop).ok);
      assert.ok((await compound).ok, `the compound call still completes: ${JSON.stringify(await compound)}`);
      for (const x of await Promise.all(reads)) assert.ok(x.ok);
      assert.equal(fc.overlaps, 0, "one line on the wire at a time");
      await host.disconnect();
    });
  }
  await test("adapter r1: setSetting is write class (H2) and restoreDefaults is write class (H6): ahead of queued reads", async () => {
    for (const which of ["setSetting", "restoreDefaults"] as const) {
      const { fc, host, mark } = await adapterRig(2);
      const release = fc.hold("status"); const m = mark();
      const status = host.getStatus(); await sleep(5);
      const reads = [host.sendCommand("get motor_direction"), host.sendCommand("dshot")];
      const w = which === "setSetting" ? host.setSetting("pid_roll_p" as never, "0.005") : host.restoreDefaults();
      release(); await Promise.all([status, ...reads, w]);
      const log = fc.log.slice(m);
      const first = which === "setSetting" ? "set pid_roll_p 0.005" : "defaults";
      assert.equal(log[1], first, `${which} goes ahead of the queued reads: ${log.slice(0, 4).join(",")}`);
      assert.deepEqual(log.slice(-2), ["get motor_direction", "dshot"]);
      await host.disconnect();
    }
  });
  await test("BLOCKER r1: leaving Motors during motor_seq at RTT 50: Stop < 300 ms after the request, nothing non-urgent first", async () => {
    const fc = new FakeFc({ rttMs: 50 });
    const host = createHost("serial", new FakeFcTransportFactory(fc)) as BobFlightHost;
    await host.connect({ path: "sim://fake-fc", transport: "serial" } as never);
    const c = new BenchController(host); c.connection(true);
    await c.poll(); c.confirmProps(true); c.confirmStationary(true);
    await c.start("sequence");
    assert.ok(fc.log.includes("motor_seq"), "the sequence started");
    fc.t0 = Date.now(); fc.wire = [];
    // The 500 ms bench poll is mid-flight and other Motors panels have reads queued.
    const poll = c.poll(); await sleep(20);
    const panel = ["storage", "get motor_poles", "get motor_direction", "mixer", "rpm_filter"].map(x => settle(host.sendCommand(x as CliCommand)));
    await sleep(5);
    // Tab switch: Motors leave() and the PID page mounts (getAllSettings, 30 gets) in the same tick.
    const t = Date.now() - fc.t0;
    const left = c.leave(); const pid = settle(host.getAllSettings());
    await waitWire(fc, "motor_test 0", t);
    const r = sentBetween(fc, t);
    console.log(`  leave during motor_seq: ${JSON.stringify({ delayMs: r.delay, sentBetween: r.between, inFlightAtRequest: fc.wire.filter(x => x.at < t).map(x => x.cmd) })}`);
    assert.ok(r.stop, "Stop was sent");
    assert.ok(r.delay < 300, `stop delay ${r.delay} ms (was 2.7-4.0 s)`);
    assert.deepEqual(r.between.filter(x => !URGENT.has(x)), [], "nothing non-urgent was sent between the Stop request and its send");
    await left; await poll;
    assert.match(c.state.reply, /Stop acknowledged/);
    assert.ok((await pid).ok, "the PID page read still completes after the Stop");
    for (const x of await Promise.all(panel)) assert.ok(x.ok || isGateNotSent(x.e));
    assert.equal(fc.overlaps, 0);
    await host.disconnect();
  });
}

async function round1NotSentTests() {
  await test("item 3: not-sent errors (queue timeout / cancel / disconnect drain) are never 'malformed' or 'older firmware'", async () => {
    for (const err of [new GateQueueTimeoutError(5000), new GateCancelledError(), new GateDisconnectedError(), new GateBusyError()]) {
      const host = { getSetting: async () => { throw err; }, setSetting: async () => { throw err; }, sendCommand: async () => { throw err; } } as never;
      const v = await readRpmKey(host, "rpm_filter_harmonics");
      assert.equal(v.kind, "busy", `${err.name}: rpm key not read (not malformed/unsupported)`);
      const rep = await readRpmReport(host);
      assert.ok(rep && (rep as { kind: string }).kind === "busy", `${err.name}: rpm report not read (not 'older FC' null)`);
      const view = rpmView(await readRpm(host), 13);
      assert.equal(view.busy, err.message, "the Filters tab carries it as busy, so the older-firmware line is hidden");
      const n = await readNotches(host);
      assert.equal(n.notRead, err.message, `${err.name}: notch reads marked not read`);
      assert.ok([1, 2].every(i => n.values[i as 1 | 2].center === null && n.values[i as 1 | 2].cutoff === null), "notch values unknown, never malformed");
      assert.equal(notchesSupported(n), false);
    }
    // A real FC "unknown key" still means an older FC.
    const old = { getSetting: async () => { throw new Error("get rpm_filter_harmonics failed: \"unknown key\""); }, sendCommand: async () => "unknown" } as never;
    assert.equal((await readRpmKey(old, "rpm_filter_harmonics")).kind, "unsupported");
  });
}

async function round1StoragePanelTests() {
  for (const how of ["unmount", "revision re-key"] as const) {
    await test(`S1/S2: StoragePanel ${how} aborts its queued storage read (signal passed); it never reaches the FC`, async () => {
      const fc = new FakeFc({ rttMs: 2 });
      const host = createHost("serial", new FakeFcTransportFactory(fc)) as BobFlightHost & { commands: CommandGate };
      await host.connect({ path: "sim://fake-fc", transport: "serial" } as never);
      g.__setupTestHost = { host, connectionStatus: "connected", version: "BobFlight 0.1.0-fakefc", status: null, postFlashGate: false,
        refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {} };
      const release = fc.hold("status"); const m = fc.log.length;
      const status = host.getStatus(); await sleep(5);
      const root = createRoot(container as never);
      flushSync(() => root.render(<StoragePanel revision={1} />)); await sleep(5);
      assert.equal(host.commands.queued, 1, "the panel's storage refresh waits behind the held status");
      if (how === "unmount") flushSync(() => root.unmount());
      else { flushSync(() => root.render(<StoragePanel revision={2} />)); await sleep(5); }
      assert.equal(host.commands.queued, how === "unmount" ? 0 : 1, "the old read was dropped from the queue at once");
      release(); await status; await sleep(40);
      const storageReads = fc.log.slice(m).filter(x => x === "storage").length;
      assert.equal(storageReads, how === "unmount" ? 0 : 1, `only the current panel's read reached the FC (${fc.log.slice(m).join(",")})`);
      if (how !== "unmount") flushSync(() => root.unmount());
      await host.disconnect(); delete g.__setupTestHost;
    });
  }
}

export async function motorsRace(rttMs: number, durationMs = 5000) {
  const fc = new FakeFc({ rttMs, saveMs: 100 });
  const host = createHost("serial", new FakeFcTransportFactory(fc)) as BobFlightHost;
  await host.connect({ path: "sim://fake-fc", transport: "serial" } as never);
  const refused: string[] = [];
  const h = host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ["sendCommand", "getStatus", "getSetting", "setSetting", "saveSettings"]) {
    const orig = h[name].bind(host);
    h[name] = (...a: unknown[]) => orig(...a).catch((e: unknown) => { if (isGateNotSent(e)) refused.push(name === "sendCommand" ? String(a[0]) : name); throw e; });
  }
  g.__setupTestHost = { host, connectionStatus: "connected", version: "BobFlight 0.1.0-fakefc", status: null, postFlashGate: false,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {} };
  const root = createRoot(container as never);
  flushSync(() => root.render(<MotorsPage />));
  const t0 = Date.now();
  const samples: { t: number; save: boolean | null; dir: boolean | null; storageOk: boolean; busyText: boolean }[] = [];
  let ticked = false, propsLost = 0, lastProps = false;
  while (Date.now() - t0 < durationMs) {
    const t = Date.now() - t0;
    if (!ticked && t > 1500) {
      ticked = true;
      flushSync(() => props(checkboxes()[0]).onChange({ target: { checked: true } })); await sleep(0);
      flushSync(() => props(checkboxes()[1]).onChange({ target: { checked: true } })); await sleep(0);
    }
    const cbs = checkboxes(); const propsOn = !!cbs[0] && !!props(cbs[0]).checked;
    if (lastProps && !propsOn) propsLost++;
    lastProps = propsOn;
    const sp = find(e => e.getAttribute("aria-label") === "Controller storage")[0];
    const sel = find(e => e.tagName === "SELECT" && e.getAttribute("aria-label") === "motor_direction")[0];
    samples.push({ t, save: dis(btn(/^Save to controller$/)), dir: dis(sel), storageOk: !!sp && /Controller flash/.test(text(sp)),
      busyText: /in flight|queue full/.test(text(container as never)) });
    await sleep(50);
  }
  const after = samples.filter(s => s.t > 2500);
  const pct = (f: (s: typeof samples[0]) => boolean) => Math.round(100 * after.filter(f).length / after.length);
  const storageReadsBeforeSave = fc.log.filter(c => c === "storage").length;
  // A user Save now also lands despite the 500 ms poll.
  const saveBtn = btn(/^Save to controller$/);
  let saveResult = "NO_BUTTON";
  if (saveBtn && !dis(saveBtn)) {
    flushSync(() => props(saveBtn).onClick({}));
    for (let i = 0; i < 60 && !/Saved to controller flash and verified|role="alert"/.test(""); i++) {
      await sleep(50);
      const sp = find(e => e.getAttribute("aria-label") === "Controller storage")[0];
      if (sp && /Saved to controller flash and verified/.test(text(sp))) { saveResult = "OK"; break; }
      const alert = sp?.findAll(e => e.getAttribute("role") === "alert").map(text)[0];
      if (alert) { saveResult = alert.slice(0, 120); break; }
    }
  } else if (saveBtn) saveResult = "BUTTON_DISABLED";
  flushSync(() => root.unmount());
  await sleep(20);
  const out = { rttMs, overlaps: fc.overlaps, refused: refused.length, refusedCmds: [...new Set(refused)].join(","),
    pctSaveDisabled: pct(s => s.save === true), pctStorageUnverified: pct(s => !s.storageOk), pctDirSelectDisabled: pct(s => s.dir === true),
    pctBusyTextVisible: pct(s => s.busyText), propsLost, storageReadsBeforeSave, saveResult, commands: fc.log.length };
  await host.disconnect();
  delete g.__setupTestHost;
  return out;
}
async function motorsTests() {
  for (const rtt of [10, 50]) {
    await test(`M1 repro (motors-race, RTT ${rtt} ms): Save box loads and stays enabled 0% disabled, zero gate refusals, props kept, one storage read`, async () => {
      const r = await motorsRace(rtt);
      console.log(`  motors-race ${JSON.stringify(r)}`);
      assert.equal(r.overlaps, 0, "one command on the wire");
      assert.equal(r.refused, 0, `no gate refusals: ${r.refusedCmds}`);
      assert.equal(r.pctSaveDisabled, 0, "Save to controller disabled 0% of the time after load (was 100%)");
      assert.equal(r.pctStorageUnverified, 0, "storage verified");
      assert.equal(r.pctDirSelectDisabled, 0, "motor_direction select usable");
      assert.equal(r.pctBusyTextVisible, 0, "no busy text");
      assert.equal(r.propsLost, 0, "props checkbox never cleared (M2)");
      assert.equal(r.storageReadsBeforeSave, 1, "one storage read at mount: the Save box is not re-keyed on rate (M4)");
      assert.equal(r.saveResult, "OK", "a user Save lands and verifies next to the 500 ms poll");
    });
  }
}

async function main() {
  await gateTests();
  await adapterTests();
  await round1GateTests();
  await round1AdapterTests();
  await round1NotSentTests();
  await round1StoragePanelTests();
  await motorsTests();
  console.log(`PASS CommandGate bounded priority FIFO (P1): ${passed} tests`);
  process.exit(0);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 150000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); });
