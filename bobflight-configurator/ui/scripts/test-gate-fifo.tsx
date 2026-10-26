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
  await motorsTests();
  console.log(`PASS CommandGate bounded priority FIFO (P1): ${passed} tests`);
  process.exit(0);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 90000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); });
