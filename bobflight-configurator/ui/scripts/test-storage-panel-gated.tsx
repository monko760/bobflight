/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * StoragePanel PR 2 render test on the REAL host adapter (createHostWithTransport:
 * real CommandGate, StorageActivity and BobFlightCliClient) over a FW-shaped
 * storage simulator (protocol/src/storage-sim.ts, wrapping MockSerial for the
 * page polls). The panel and the pages render in the #57 fake DOM with only
 * `useHost` stubbed (run-storage-panel-gated.mjs). Asserts visible text, what
 * went on the wire, and gate attempts.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { StoragePanel } from "../src/components/StoragePanel";
import { STORAGE_BUSY_TEXT, STORAGE_BUSY_RETRIES, STORAGE_BUSY_RETRY_MS, STORAGE_SAVE_OUTCOME_UNKNOWN_TEXT, runStorageGated, StorageBusyError, StorageCancelledError, describeStorageError } from "../src/components/storageSequence";
import { ReceiverPage } from "../src/pages/ReceiverPage";
import { PowerBatteryPage } from "../src/pages/PowerBatteryPage";
import { SensorsPage } from "../src/pages/SensorsPage";
import { ModesPage } from "../src/pages/ModesPage";
import { PortsPage } from "../src/pages/PortsPage";
import { SNAPSHOT_NOT_SENT_TEXT, SNAPSHOT_READBACK_NOT_SENT_TEXT, useConfigSnapshot } from "../src/pages/useConfigSnapshot";
import { RatesPage } from "../src/pages/RatesPage";
import { MotorsPage } from "../src/pages/MotorsPage";
import { createHostWithTransport } from "../src/protocol/createHost";
import {
  isGateBusy, gateErrorCode, GATE_BUSY_MESSAGE, GATE_START_BUSY_MESSAGE, GATE_QUEUE_LIMIT, GATE_QUEUE_TIMEOUT_MS, CommandGate, GateBusyError,
  GateQueueTimeoutError, GateCancelledError, GateDisconnectedError, GateSessionChangedError,
} from "../src/protocol";
import { parseStatus, type CliCommand } from "@bobflight/protocol";
import { MockStorageFirmware, StorageSimTransportFactory, type StorageSimOptions } from "../../protocol/src/storage-sim";

const { container } = installFakeDom();
// useSensorTelemetry reads document.visibilityState; React itself only probes window.document.
(globalThis as Record<string, unknown>).document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(5); }
  return pred();
}
let passed = 0;
const only = process.env.STORAGE_TEST_ONLY;
async function test(name: string, fn: () => Promise<void>) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`PASS ${name}`); }

// ---- what a user sees ----------------------------------------------------------
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
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function button(text: string): FakeElement {
  const b = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === text)[0];
  assert.ok(b, `button "${text}" rendered`);
  return b;
}
function click(text: string) {
  const b = button(text);
  assert.ok(!isDisabled(b), `button "${text}" is enabled`);
  const k = Object.keys(b).find((x) => x.startsWith("__reactProps$"))!;
  flushSync(() => (b as unknown as Record<string, { onClick(ev: unknown): void }>)[k].onClick({}));
}
const storageStatus = () => shown("storage-status") ?? "";
const storageError = () => shown("storage-error");
const loaded = () => /^Controller flash · /.test(storageStatus());

// ---- rig: real adapter + storage FW sim ------------------------------------------
interface Rig {
  fw: MockStorageFirmware; host: ReturnType<typeof createHostWithTransport>;
  ctx: Record<string, unknown>; render(el: ReactElement): void; unmount(): void;
  /** runStorageSequence calls (gate attempts), how many the gate refused (queue full) and how many found it in use and waited in its FIFO. */
  gate: { attempts: number; refused: number; waited: number };
  /** Holds the REAL CommandGate (as another page's slow command would) for `ms`. `full`: also fills its FIFO
   * (GATE_QUEUE_LIMIT waiting no-op runs that send nothing), so every further command is refused as busy. */
  holdGate(ms: number, full?: boolean): Promise<unknown>;
  /** The adapter's real CommandGate (read-only use: busy / queued). */
  commands: CommandGate;
  done(): Promise<void>;
}
async function rig(o: StorageSimOptions = {}): Promise<Rig> {
  const fw = new MockStorageFirmware(o);
  const host = createHostWithTransport(new StorageSimTransportFactory(fw));
  await host.connect({ path: "sim://bobflight-storage", transport: "serial" });
  assert.equal(host.getConnectionStatus(), "connected");
  const gate = { attempts: 0, refused: 0, waited: 0 };
  const commands = (host as unknown as { commands: CommandGate }).commands;
  const real = host.runStorageSequence!.bind(host);
  host.runStorageSequence = <T,>(work: Parameters<typeof real>[0], opts?: Parameters<typeof real>[1]) => {
    gate.attempts++;
    const inUse = commands.busy || commands.queued > 0;
    return (real(work, opts) as Promise<T>).then((v) => { if (inUse) gate.waited++; return v; },
      (e) => { if (isGateBusy(e)) gate.refused++; else if (inUse) gate.waited++; throw e; });
  };
  let root: Root | null = createRoot(container as never);
  let current: ReactElement | null = null;
  const rerender = () => { if (root && current) flushSync(() => root!.render(current!)); };
  const ctx: Record<string, unknown> = {
    host, connectionStatus: "connected", lastError: null, setLastError: () => {}, version: "BobFlight sim", status: null,
    cliLines: [], appendCli: () => {}, clearCli: () => {}, postFlashGate: false, setPostFlashGate: () => {},
    refreshStatus: async () => { ctx.status = parseStatus(await host.sendCommand("status")); setTimeout(rerender, 0); },
    pollAfterConnect: async () => {}, clearPostFlashGateAfterReconnect: async () => true,
  };
  host.onStatus((s) => { ctx.connectionStatus = s; setTimeout(rerender, 0); });
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  return {
    fw, host, ctx, gate, commands,
    render(el) { current = el; if (!root) root = createRoot(container as never); rerender(); },
    unmount() { if (root) { root.unmount(); root = null; } current = null; },
    holdGate: (ms, full = false) => {
      const held = real(() => sleep(ms)).catch((e) => e);
      const fillers = full ? Array.from({ length: GATE_QUEUE_LIMIT }, () => real(async () => undefined).catch((e) => e)) : [];
      if (full) assert.equal(commands.queued, GATE_QUEUE_LIMIT, "the gate's FIFO is full");
      return Promise.all([held, ...fillers]).then(([h]) => h);
    },
    async done() { if (root) root.unmount(); root = null; await host.disconnect(); await sleep(10); },
  };
}

/** An independent poller on the real gate, as another page's telemetry loop: `status` every `periodMs`, never overlapping itself. */
function poller(host: Rig["host"], periodMs: number) {
  const stats = { ok: 0, busy: 0, waited: 0, other: [] as string[] };
  const commands = (host as unknown as { commands: CommandGate }).commands;
  let inflight = false;
  const t = setInterval(() => {
    if (inflight) return;
    inflight = true;
    if (commands.busy || commands.queued > 0) stats.waited++;
    host.sendCommand("status").then(() => { stats.ok++; }, (e) => { if (isGateBusy(e)) stats.busy++; else stats.other.push(String(e)); }).finally(() => { inflight = false; });
  }, periodMs);
  return { stats, stop: () => clearInterval(t) };
}

/** Each `save` on the wire is directly between two `storage` lines (one gated run: nothing squeezed in). */
function assertContiguousSaves(log: string[]) {
  log.forEach((l, i) => {
    if (l !== "save") return;
    assert.equal(log[i - 1], "storage", `line before save #${i} is storage, got ${log[i - 1]} (${log.slice(Math.max(0, i - 3), i + 3).join(", ")})`);
    assert.equal(log[i + 1], "storage", `line after save #${i} is storage, got ${log[i + 1]} (${log.slice(Math.max(0, i - 3), i + 3).join(", ")})`);
  });
}

async function cycles(periodMs: number, n = 20) {
  const r = await rig();
  const p = poller(r.host, periodMs);
  await sleep(periodMs * 2);
  const failures: string[] = [];
  let saves = 0;
  try {
    for (let i = 0; i < n; i++) {
      r.fw.markDirty();
      const gen = r.fw.generation;
      r.render(<StoragePanel requiredScope="receiver_map" />);
      const ok = await waitFor(() => /· dirty · unsaved changes ·/.test(storageStatus()) || storageError() !== null, 6000);
      if (!ok || storageError() !== null) { failures.push(`cycle ${i} load: ${storageError() ?? storageStatus()}`); r.unmount(); continue; }
      click("Save to controller");
      const done = await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || storageError() !== null, 8000);
      if (!done || storageError() !== null) failures.push(`cycle ${i} save: ${storageError() ?? "no result"} ${shown("storage-error-detail") ?? ""}`);
      else {
        saves++;
        assert.match(storageStatus(), /^Controller flash · saved · no unsaved changes · generation /);
        assert.equal(r.fw.generation, gen + 1, "the FC really saved once");
      }
      r.unmount();
    }
  } finally { p.stop(); }
  await sleep(periodMs + 60);
  assertContiguousSaves(r.fw.log);
  assert.equal(r.fw.count("save"), saves, "exactly one save line per Save click (no retried saves)");
  const result = { failures, saves, poller: p.stats, gate: { ...r.gate } };
  await r.done();
  return result;
}

async function main() {
  await test("20 mount+save cycles next to a 200 ms poller on the real gate: 0 load/save failures, every save one contiguous gated run", async () => {
    const res = await cycles(200);
    console.log(`  200 ms poller: ${res.saves}/20 saves, ${res.failures.length} failures; poller ok ${res.poller.ok} queued ${res.poller.waited} busy ${res.poller.busy}; panel gated runs ${res.gate.attempts} queued ${res.gate.waited} refused ${res.gate.refused}`);
    assert.deepEqual(res.failures, []);
    assert.equal(res.saves, 20);
    assert.deepEqual(res.poller.other, [], "the poller never saw a non-busy error (no client overlap)");
    assert.ok(res.poller.ok >= 1 && res.poller.ok + res.poller.busy > 5, "the poller really ran");
  });

  await test("20 mount+save cycles next to a 50 ms poller on the real (FIFO) gate: 0 load/save failures, contention really happened, every save one contiguous gated run", async () => {
    const res = await cycles(50);
    console.log(`  50 ms poller: ${res.saves}/20 saves, ${res.failures.length} failures; poller ok ${res.poller.ok} queued ${res.poller.waited} busy ${res.poller.busy}; panel gated runs ${res.gate.attempts} queued ${res.gate.waited} refused ${res.gate.refused}`);
    assert.deepEqual(res.failures, []);
    assert.equal(res.saves, 20);
    assert.deepEqual(res.poller.other, []);
    // FIFO gate: contention shows as waiting in the queue (both ways), not as refusals.
    assert.ok(res.gate.waited > 0, "the 50 ms poller really contended for the gate (panel runs waited behind it)");
    assert.ok(res.poller.waited > 0, "the panel's gated runs really held the gate against the poller");
  });

  await test("Save is ONE gated run: competing commands tried on every microtask after each reply of the sequence wait (or are refused when the FIFO is full); nothing reaches the FC between storage, save, storage", async () => {
    const r = await rig();
    r.fw.markDirty();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    const outcomes: string[] = [];
    let spinning = false;
    // Right after the FC's reply to `storage` (and to `save`) reaches the host, try a competing command on each of the
    // next 400 microtasks: with a per-command gate one of them lands in the gap between two commands of the sequence.
    r.fw.afterReply = (line) => {
      if ((line !== "storage" && line !== "save") || spinning || outcomes.includes("sent")) return;
      spinning = true;
      let hops = 0;
      const spin = (): void => {
        if (hops++ >= 400 || outcomes.includes("sent")) { spinning = false; return; }
        r.host.sendCommand("status").then(() => { outcomes.push("sent"); }, (e) => { outcomes.push(isGateBusy(e) ? "busy" : String(e)); });
        queueMicrotask(spin);
      };
      spin();
    };
    const mark = r.fw.log.length;
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError()));
    await sleep(80);
    r.fw.afterReply = null;
    assert.equal(storageError(), null);
    const during = r.fw.log.slice(mark);
    const i = during.indexOf("save");
    assert.deepEqual(during.slice(Math.max(0, i - 1), i + 2), ["storage", "save", "storage"], `wire: ${during.join(", ")}`);
    assert.ok(outcomes.length >= 400, `competing commands were really tried (${outcomes.length})`);
    assert.ok(outcomes.every((o) => o === "busy" || o === "sent"), `competitors only waited or were refused as busy: ${[...new Set(outcomes)].join(", ")}`);
    assert.ok(!outcomes.includes("sent") || during.indexOf("status") > i + 1, `no competing command got in between: ${during.join(", ")}`);
    await r.done();
  });

  await test("no retry on a real FW error: `save failed: <token>` shown verbatim, one save line, one gate run", async () => {
    const r = await rig();
    r.fw.markDirty();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    const before = r.gate.attempts;
    r.fw.failNextSave = "error";
    click("Save to controller");
    assert.ok(await waitFor(() => !!storageError()));
    await sleep(300);
    assert.equal(storageError(), "The controller did not confirm the save. Your settings may not be stored.");
    assert.equal(shown("storage-error-detail"), "Controller reply: save failed: error", "FW line verbatim, visible");
    assert.equal(r.fw.count("save"), 1, "a FW refusal is never retried");
    assert.equal(r.gate.attempts - before, 1, "one gated run");
    assert.ok(!pageText().includes("Legacy/demo"), "no Legacy/demo firmware copy");
    assert.ok(!pageText().includes("Saved to controller flash"), "no success claim");
    await r.done();
  });

  await test("no retry on a client error: an oversized `storage` reply is shown verbatim once; a reply timeout resets the link, also without a retry", async () => {
    const r = await rig();
    r.fw.replyOnce.set("storage", ["x".repeat(70000) + "\r\n"]);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(() => !!storageError(), 4000));
    await sleep(200);
    assert.equal(storageError(), "CLI response exceeds 65536-character limit");
    assert.equal(r.fw.count("storage"), 1, "a client error is not retried");
    assert.equal(r.gate.attempts, 1);
    assert.equal(storageStatus(), "Storage capability not yet verified.");
    await r.done();
    const t = await rig();
    t.fw.replyOnce.set("storage", [null]);
    t.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(() => t.host.getConnectionStatus() !== "connected", 4000), "the client resets the link after a framed reply times out");
    await sleep(300);
    assert.equal(t.fw.count("storage"), 1, "the timeout is not retried");
    assert.equal(t.gate.attempts, 1);
    assert.ok(!pageText().includes("Saved to controller"));
    await t.done();
  });

  await test("bounded busy retry: a gate held 5 s with its FIFO full gives up after 1+" + STORAGE_BUSY_RETRIES + " attempts (~3 s) with plain text + the raw refusal; nothing sent", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(4500, true);
    const sentBefore = r.fw.log.length, attemptsBefore = r.gate.attempts, t0 = Date.now();
    click("Save to controller");
    assert.ok(await waitFor(() => !!storageError(), 5000), "gave up while the gate was still held");
    const elapsed = Date.now() - t0;
    assert.equal(storageError(), STORAGE_BUSY_TEXT.save);
    assert.equal(storageError(), "Another command was using the connection, so nothing was saved. Try Save to controller again.");
    assert.equal(shown("storage-error-detail"), `Nothing was sent to the controller. Connection reply: ${GATE_BUSY_MESSAGE}`);
    assert.equal(r.gate.attempts - attemptsBefore, STORAGE_BUSY_RETRIES + 1, "exactly 1 + retries panel attempts");
    assert.ok(elapsed >= STORAGE_BUSY_RETRIES * STORAGE_BUSY_RETRY_MS * 0.9 && elapsed < 4800, `bounded (~3 s): ${elapsed} ms`);
    assert.deepEqual(r.fw.log.slice(sentBefore), [], "nothing reached the FC");
    assert.match(storageStatus(), /^Controller flash · saved · /, "busy keeps the last verified status (nothing was read)");
    assert.ok(!pageText().includes("Legacy/demo"));
    await held;
    await r.done();
  });

  await test("busy for a moment (FIFO full), then free: the Save retries and succeeds with one save line", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(250, true);
    const attemptsBefore = r.gate.attempts;
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
    assert.equal(storageError(), null);
    assert.ok(r.gate.attempts - attemptsBefore > 2, "the panel retried while the gate was busy");
    assert.equal(r.fw.count("save"), 1);
    await held; await r.done();
  });

  await test("busy initial load (another page holds the gate at mount, FIFO full) retries and loads", async () => {
    const r = await rig();
    const held = r.holdGate(200, true);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded, 3000));
    assert.equal(storageError(), null);
    assert.ok(r.gate.refused > 0);
    await held; await r.done();
  });

  await test("FIFO gate in use (queue not full): the Save waits in the queue as ONE run, no refusal, no retry, one save line", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const before = { ...r.gate }, mark = r.fw.log.length;
    const held = r.holdGate(300);
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
    assert.equal(storageError(), null);
    assert.equal(r.gate.attempts - before.attempts, 1, "one gated run, no retry");
    assert.equal(r.gate.refused - before.refused, 0, "the FIFO gate queued it instead of refusing");
    assert.equal(r.gate.waited - before.waited, 1, "it really waited behind the held gate");
    assert.deepEqual(r.fw.log.slice(mark), ["storage", "save", "storage"]);
    await held; await r.done();
  });

  await test("FIFO queue timeout: a Save still waiting after the gate's queue limit is reported as busy (plain text + the gate's line), not retried, nothing sent", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const before = r.gate.attempts, mark = r.fw.log.length;
    const held = r.holdGate(GATE_QUEUE_TIMEOUT_MS + 400);
    click("Save to controller");
    assert.ok(await waitFor(() => !!storageError(), GATE_QUEUE_TIMEOUT_MS + 300));
    assert.equal(storageError(), STORAGE_BUSY_TEXT.save);
    assert.equal(shown("storage-error-detail"), `Nothing was sent to the controller. Connection reply: timed out after ${GATE_QUEUE_TIMEOUT_MS} ms waiting in the command queue; request not sent`);
    assert.equal(r.gate.attempts - before, 1, "no retry after a queue timeout");
    assert.deepEqual(r.fw.log.slice(mark), [], "nothing reached the FC");
    assert.match(storageStatus(), /^Controller flash · saved · /, "busy keeps the last verified status");
    await held; await r.done();
  });

  await test("FIFO cancel: unmounting while the load still waits in the queue drops it (nothing sent, no error)", async () => {
    const r = await rig();
    const held = r.holdGate(300);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(() => r.commands.queued === 1, 1000), "the auto-load is waiting in the FIFO");
    const mark = r.fw.log.length;
    r.unmount();
    assert.equal(r.commands.queued, 0, "abort dropped it from the queue");
    await held; await sleep(50);
    assert.deepEqual(r.fw.log.slice(mark), [], "the dropped load was never sent");
    await r.done();
  });

  await test("both busy codes are retried on a real FIFO CommandGate (GATE_QUEUE_FULL, GATE_BUSY_START), matched by code", async () => {
    // Queue full: a real gate with a bound of 1, held, with one command waiting.
    const full = new CommandGate(() => 1, 1);
    let release = () => {};
    const holding = full.run(() => new Promise<void>((r) => { release = r; }));
    const waiting = full.run(async () => undefined);
    let tries = 0, sentLines: string[] = [];
    const errs: unknown[] = [];
    const fullHost = { sendCommand: async () => "", runStorageSequence: <T,>(work: (s: (c: string) => Promise<string>) => Promise<T>) => {
      tries++; if (tries === 3) release();
      return full.run(() => work(async (c) => { sentLines.push(c); return "ok"; })).catch((e) => { errs.push(e); throw e; });
    } };
    const v1 = await runStorageGated(fullHost as never, "refresh", async (send) => { await send("storage"); return 1; }, { sleep: () => sleep(5) });
    await holding; await waiting;
    assert.equal(v1, 1);
    assert.ok(errs.length >= 2 && errs.every((e) => gateErrorCode(e) === "GATE_QUEUE_FULL"), "refused with GATE_QUEUE_FULL, then retried");
    assert.deepEqual(sentLines, ["storage"], "one line once the queue had room");
    // Refused motor start: an exclusive run on a busy real gate (starts are never queued).
    const start = new CommandGate(() => 1);
    let release2 = () => {};
    const holding2 = start.run(() => new Promise<void>((r) => { release2 = r; }));
    tries = 0; sentLines = []; errs.length = 0;
    const startHost = { sendCommand: async () => "", runStorageSequence: <T,>(work: (s: (c: string) => Promise<string>) => Promise<T>) => {
      tries++; if (tries === 3) release2();
      return start.run(() => work(async (c) => { sentLines.push(c); return "ok"; }), { exclusive: true }).catch((e) => { errs.push(e); throw e; });
    } };
    const v2 = await runStorageGated(startHost as never, "refresh", async (send) => { await send("storage"); return 2; }, { sleep: () => sleep(5) });
    await holding2;
    assert.equal(v2, 2);
    assert.ok(errs.length >= 2 && errs.every((e) => gateErrorCode(e) === "GATE_BUSY_START"), "refused with GATE_BUSY_START, then retried");
    assert.match(GATE_START_BUSY_MESSAGE, /^busy, try again/, "#99 round 1 wording (UI copy only; never matched)");
    assert.deepEqual(sentLines, ["storage"]);
  });

  /** A host whose gated run throws `errs[i]` on attempt i, then runs the work (one `storage` line). */
  function scripted(errs: unknown[]) {
    const st = { calls: 0, lines: 0 };
    const host = { sendCommand: async () => "", runStorageSequence: async <T,>(work: (s: (c: string) => Promise<string>) => Promise<T>) => {
      const e = errs[st.calls++]; if (e !== undefined) throw e;
      return work(async () => { st.lines++; return "ok"; });
    } };
    return { host: host as never, st };
  }

  await test("busy by CODE, not text: a GateBusyError whose message is reworded but keeps GATE_QUEUE_FULL / GATE_BUSY_START is still retried", async () => {
    for (const code of ["GATE_QUEUE_FULL", "GATE_BUSY_START"] as const) {
      const reworded = new GateBusyError("the connection is occupied, please hold", code);
      assert.equal(gateErrorCode(reworded), code);
      const { host, st } = scripted([reworded, reworded, reworded]);
      const v = await runStorageGated(host, "save", async (send) => { await send("storage"); return 7; }, { sleep: async () => {} });
      assert.equal(v, 7, `${code}: retried past three reworded refusals`);
      assert.equal(st.calls, 4, `${code}: 3 refusals + 1 run`);
      assert.equal(st.lines, 1);
    }
  });

  await test("'busy' text with no gate code is a real error: never retried, never shown as busy (incl. the gate's own wording on a plain Error)", async () => {
    const msgs = [GATE_BUSY_MESSAGE, GATE_START_BUSY_MESSAGE, "busy, try again", "busy: motor test running", "save failed: flash busy",
      "another UI command is in flight; request not queued (from the FC)"];
    const fakes: Error[] = msgs.map((m) => new Error(m));
    // A plain Error that copies the code (but is not a gate rejection) is not busy either.
    fakes.push(Object.assign(new Error(GATE_BUSY_MESSAGE), { code: "GATE_QUEUE_FULL" }));
    fakes.push(Object.assign(new Error("busy"), { code: "GATE_BUSY_START", gate: "yes" }));
    for (const e of fakes) {
      assert.equal(isGateBusy(e), false, `no gate code: ${e.message}`);
      const { host, st } = scripted([e, e, e]);
      await assert.rejects(runStorageGated(host, "save", async () => 1, { sleep: async () => {} }), (x) => x === e, `rethrown unchanged: ${e.message}`);
      assert.equal(st.calls, 1, `not retried: ${e.message}`);
      assert.equal(describeStorageError(e).kind, "other", `not shown as busy: ${e.message}`);
    }
  });

  await test("not sent, no retry: queue timeout / disconnect drain / session change / a cancel the panel did not ask for show the busy text + 'Nothing was sent'", async () => {
    const cases: Array<[unknown, string]> = [
      [new GateQueueTimeoutError(GATE_QUEUE_TIMEOUT_MS), "GATE_QUEUE_TIMEOUT"], [new GateDisconnectedError(), "GATE_DISCONNECTED"],
      [new GateSessionChangedError(), "GATE_SESSION_CHANGED"], [new GateCancelledError(), "GATE_CANCELLED"],
    ];
    for (const [e, code] of cases) {
      const { host, st } = scripted([e, e]);
      let caught: unknown;
      await runStorageGated(host, "save", async () => 1, { sleep: async () => {} }).catch((x) => { caught = x; });
      assert.ok(caught instanceof StorageBusyError, `${code}: busy wording`);
      assert.equal((caught as StorageBusyError).code, code);
      assert.equal((caught as StorageBusyError).attempts, 1);
      assert.equal(st.calls, 1, `${code}: no retry`);
      const p = describeStorageError(caught);
      assert.equal(p.kind, "busy");
      assert.equal(p.text, STORAGE_BUSY_TEXT.save);
      assert.equal(p.detail, `Nothing was sent to the controller. Connection reply: ${(e as Error).message}`);
    }
    // The panel's own abort (unmount / revision change) while queued: silent, no retry.
    const ac = new AbortController();
    let ownCalls = 0;
    const ownHost = { sendCommand: async () => "", runStorageSequence: async () => { ownCalls++; ac.abort(); throw new GateCancelledError(); } };
    await assert.rejects(runStorageGated(ownHost as never, "save", async () => 1, { signal: ac.signal, sleep: async () => {} }), StorageCancelledError);
    assert.equal(ownCalls, 1);
  });

  await test("bounded retry helper by behaviour: never retries a non-busy error, retries are counted and capped", async () => {
    let calls = 0;
    const fwErr = { sendCommand: async () => "", runStorageSequence: async () => { calls++; throw new Error("save failed: error"); } };
    await assert.rejects(runStorageGated(fwErr as never, "save", async () => 1, { sleep: async () => {} }), /save failed: error/);
    assert.equal(calls, 1);
    calls = 0;
    const busy = { sendCommand: async () => "", runStorageSequence: async () => { calls++; throw new GateBusyError(); } };
    await assert.rejects(runStorageGated(busy as never, "refresh", async () => 1, { retries: 7, sleep: async () => {} }), (e) => e instanceof StorageBusyError && e.attempts === 8 && e.code === "GATE_QUEUE_FULL");
    assert.equal(calls, 8);
    // Line-by-line host (no gated run): a refusal after a line already went out is not retried.
    calls = 0;
    const lineHost = { sendCommand: async (c: CliCommand) => { calls++; if (c === "save") throw new GateBusyError(); return "x"; } };
    let partial: unknown;
    await runStorageGated(lineHost as never, "save", async (send) => { await send("storage"); return send("save"); }, { sleep: async () => {} }).catch((e) => { partial = e; });
    assert.ok(partial instanceof StorageBusyError);
    assert.equal(calls, 2, "storage then a refused save; the sequence is not replayed");
    assert.equal(describeStorageError(partial).detail, `The rest of the sequence was not sent. Connection reply: ${GATE_BUSY_MESSAGE}`);
    // Lines already went out: the headline never claims "nothing was saved"; the outcome is unknown, re-read.
    assert.equal((partial as Error).message, STORAGE_SAVE_OUTCOME_UNKNOWN_TEXT);
    assert.ok(!/nothing was saved/i.test(describeStorageError(partial).text));
    assert.equal(describeStorageError(partial).kind, "unknown", "not 'busy': the panel does not keep the old status as verified");
    // S3: a gate refusal of the FIRST line on a line-by-line host is not counted as sent, so it is retried.
    calls = 0;
    const firstRefused = { sendCommand: async () => { calls++; if (calls <= 2) throw new GateBusyError(); return "x"; } };
    assert.equal(await runStorageGated(firstRefused as never, "refresh", async (send) => send("storage"), { sleep: async () => {} }), "x");
    assert.equal(calls, 3, "two refusals of the first line, then sent");
  });

  await test("Stop preempts the held storage run: an urgent `motor_test 0` queued during a Save goes on the wire before the next line; the Save still verifies", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    let stop: Promise<string> | null = null;
    const mark = r.fw.log.length;
    r.fw.onLine = (line) => { if (line === "storage" && !stop) stop = r.host.sendCommand("motor_test 0"); };
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
    r.fw.onLine = null;
    assert.equal(storageError(), null, `save verified (${shown("storage-error-detail")})`);
    assert.ok(stop, "Stop was queued while the save held the gate");
    await stop;
    assert.deepEqual(r.fw.log.slice(mark), ["storage", "motor_test 0", "save", "storage"], "Stop went out right after the reply on the wire, ahead of the rest of the sequence");
    assert.equal(r.fw.count("save"), 1);
    await r.done();
  });

  await test("Stop with the panel's load still queued: Stop jumps ahead, the panel's waiting run is not dropped and loads after it", async () => {
    const r = await rig();
    const held = r.holdGate(250);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(() => r.commands.queued === 1, 1000), "the auto-load is waiting in the FIFO");
    const mark = r.fw.log.length;
    const stop = r.host.sendCommand("motor_test 0");
    await held; await stop;
    assert.ok(await waitFor(loaded, 2000));
    assert.equal(storageError(), null);
    assert.deepEqual(r.fw.log.slice(mark), ["motor_test 0", "storage"], "Stop first, then the panel's queued load");
    await r.done();
  });

  await test("a queued Save dropped by the gate (disconnect drain) ends cleanly: busy text + 'Nothing was sent', no retry, nothing sent, last status kept", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(300);
    const before = r.gate.attempts, mark = r.fw.log.length;
    click("Save to controller");
    assert.ok(await waitFor(() => r.commands.queued === 1, 1000), "the save is waiting in the FIFO");
    r.commands.drain();
    assert.ok(await waitFor(() => !!storageError(), 1000));
    assert.equal(storageError(), STORAGE_BUSY_TEXT.save);
    assert.equal(shown("storage-error-detail"), "Nothing was sent to the controller. Connection reply: disconnected");
    assert.equal(r.gate.attempts - before, 1, "no retry");
    await held; await sleep(50);
    assert.deepEqual(r.fw.log.slice(mark), [], "the dropped save was never sent");
    assert.match(storageStatus(), /^Controller flash · saved · /, "last verified status kept");
    assert.ok(!isDisabled(button("Save to controller")), "the panel is usable again");
    await r.done();
  });

  await test("F5: a storage reply with a mismatched scope says the reply could not be read, shows the raw reply, never 'Fresh install required'", async () => {
    const r = await rig();
    const bad = r.fw.storageReply().replace(/scope: [^\r]+/, "scope: pid_rates,receiver_uart");
    r.fw.replyOnce.set("storage", [bad]);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(() => !!storageError()));
    assert.equal(storageError(), "The controller’s storage reply could not be read, so storage status is unknown.");
    const detail = shown("storage-error-detail") ?? "";
    assert.match(detail, /^Storage reply could not be read: scope does not match storage schema 13\. Controller reply: storage_api: 1/);
    assert.ok(detail.includes("scope: pid_rates,receiver_uart"), "raw line visible");
    assert.ok(!/Fresh install/i.test(pageText()));
    assert.equal(r.fw.count("storage"), 1, "a parse failure is not retried");
    assert.ok(isDisabled(button("Save to controller")));
    await r.done();
  });

  await test("F5: an unknown storage_api, a missing field and an unknown backend are 'could not be read' with the raw reply", async () => {
    for (const mangle of [(s: string) => s.replace("storage_api: 1", "storage_api: 2"), (s: string) => s.replace("armed: 0\r\n", ""), (s: string) => s.replace("backend: flash", "backend: eeprom")]) {
      const r = await rig();
      const bad = mangle(r.fw.storageReply());
      r.fw.replyOnce.set("storage", [bad]);
      r.render(<StoragePanel requiredScope="receiver_map" />);
      assert.ok(await waitFor(() => !!storageError(), 4000));
      assert.equal(storageError(), "The controller’s storage reply could not be read, so storage status is unknown.");
      assert.match(shown("storage-error-detail") ?? "", /^Storage reply could not be read: .+\. Controller reply: storage_api: [12]\r?\n/);
      assert.ok((shown("storage-error-detail") ?? "").includes(bad.trim()), "the whole raw reply is visible");
      assert.ok(!/Fresh install/i.test(pageText()));
      await r.done();
    }
  });

  await test("StoragePanel: `blocked` flipping never resets the panel; an unblock only re-reads quietly (status shown throughout)", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(loaded));
    const loads = r.fw.count("storage"), text = storageStatus();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      r.render(<StoragePanel requiredScope="receiver_map" blocked={i % 2 === 0} />);
      const end = Date.now() + 40; while (Date.now() < end) { seen.add(storageStatus()); await sleep(2); }
    }
    await sleep(100); seen.add(storageStatus());
    assert.deepEqual([...seen], [text], "the verified status stayed on screen the whole time (never reset)");
    assert.ok(r.fw.count("storage") - loads <= 3, "at most one quiet re-read per unblock");
    await r.done();
  });

  await test("StoragePanel: the automatic first load waits while the page is blocked (its own first read goes first), then loads once", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" blocked={true} />);
    await sleep(150);
    assert.equal(r.fw.count("storage"), 0, "no storage read while blocked");
    assert.equal(storageStatus(), "Storage capability not yet verified.");
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(loaded, 2000));
    await sleep(50);
    assert.equal(r.fw.count("storage"), 1, "exactly one load after unblocking");
    await r.done();
  });

  await test("StoragePanel: after the page unblocks (an apply finished) storage is re-read quietly and shows the FC's unsaved changes", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(loaded));
    assert.match(storageStatus(), /· saved · no unsaved changes ·/);
    r.render(<StoragePanel requiredScope="receiver_map" blocked={true} />);
    r.fw.markDirty(); // the page applied a setting on the FC
    await sleep(30);
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(() => /· dirty · unsaved changes ·/.test(storageStatus()), 2000), storageStatus());
    assert.equal(storageError(), null);
    await r.done();
  });

  // ---- G3: a page poll error must not reset the panel ------------------------------
  async function pagePollError(name: string, page: ReactElement, poll: string, failure: string, ready: () => boolean, extra?: (r: Rig) => void, saveStaysEnabled = true, quietReads = 0) {
    const r = await rig({ liveSensors: true });
    r.fw.markDirty();
    r.render(page);
    assert.ok(await waitFor(() => loaded() && ready(), 6000), `${name}: page and panel loaded (${storageStatus()})`);
    assert.ok(!pageText().includes("request not queued"), `${name}: the page's own first read was not refused by the panel`);
    await sleep(300);
    const loads = r.fw.count("storage"), text = storageStatus();
    assert.ok(!isDisabled(button("Save to controller")), `${name}: Save enabled before the poll errors`);
    r.fw.replyOnce.set(poll, Array(6).fill(failure));
    const seenBefore = r.fw.count(poll);
    let saveDisabledSeen = false;
    const until = Date.now() + 6000;
    const statuses = new Set<string>();
    while (r.fw.replyOnce.has(poll) && Date.now() < until) { if (isDisabled(button("Save to controller"))) saveDisabledSeen = true; statuses.add(storageStatus()); await sleep(5); }
    assert.ok(r.fw.count(poll) - seenBefore >= 6, `${name}: the failing polls really ran`);
    await sleep(60);
    extra?.(r);
    statuses.add(storageStatus());
    assert.deepEqual([...statuses], [text], `${name}: the verified storage status stayed on screen through the poll errors (never reset)`);
    assert.ok(r.fw.count("storage") - loads <= quietReads, `${name}: no storage reload after poll errors (${r.fw.count("storage") - loads} reads, ${quietReads} quiet re-reads allowed)`);
    assert.equal(storageStatus(), text, `${name}: storage status kept`);
    assert.equal(storageError(), null, `${name}: no storage error`);
    if (saveStaysEnabled) assert.equal(saveDisabledSeen, false, `${name}: Save stayed available (the panel was not blocked/reset by the poll error)`);
    // And a busy gate during the page poll (another storage action) is not an error either.
    const loads2 = r.fw.count("storage");
    const held = r.holdGate(400, true); await held; await sleep(30);
    assert.ok(r.fw.count("storage") - loads2 <= quietReads, `${name}: busy poll did not reload storage`);
    assert.equal(storageStatus(), text, `${name}: storage status kept after a busy poll`);
    {
      assert.ok(await waitFor(() => !isDisabled(button("Save to controller")), 2000), `${name}: Save available again`);
      click("Save to controller");
      assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
      assert.equal(storageError(), null, `${name}: Save works after the poll errors`);
    }
    await r.done();
  }
  await test("G3 Receiver: failed receiver polls keep the panel (no reset/reload), Save stays available; page shows the error", async () => {
    await pagePollError("Receiver", <ReceiverPage />, "receiver", "receiver failed: uart io\r\n", () => pageText().includes("Applied UART:") && !pageText().includes("Applied UART: —"), () => {
      assert.ok(pageText().includes("receiver failed: uart io"), "the poll error is shown on the page");
    });
  });
  await test("G3 Power & Battery: failed power polls keep the panel, mark the reading out of date", async () => {
    await pagePollError("Power", <PowerBatteryPage />, "power", "unknown — try help\r\n", () => pageText().includes("16.40 V"), () => {
      assert.ok(pageText().includes("No complete battery response"), "the poll error is shown on the page");
      assert.equal(shown("power-stale"), "Last battery reading is out of date: the latest read failed.");
      assert.ok(!pageText().includes("16.40 V"), "a stale reading is not shown as live");
    });
  });
  await test("G3 Sensors: failed sensor polls (telemetry reset) never change the panel revision or reload it", async () => {
    await pagePollError("Sensors", <SensorsPage />, "sensors", "sensors_version: 1\r\nbroken\r\nsensors_end: 1\r\n", () => pageText().includes("Gyro"), (r) => {
      assert.ok(r.fw.count("sensors") > 6, "the 50 ms sensor poll ran");
    }, false /* Sensors blocks Save without a fresh sample; that block must not reset the panel */, 2 /* a quiet re-read when fresh data returns */);
  });

  await test("G3 Motors: failed DShot rate polls (rate cleared to null) never change the panel revision or reload it", async () => {
    await pagePollError("Motors", <MotorsPage />, "dshot", "unknown — try help\r\n", () => pageText().includes("DShot300"), () => {
      assert.ok(pageText().includes("DShot rate readback unavailable"), "the poll error is shown on the page");
    });
  });

  // ---- the other StoragePanel hosts load and save through the same gated run -------
  for (const [name, el] of [["Modes", <ModesPage />], ["Ports", <PortsPage />], ["Motors", <MotorsPage />]] as const) {
    await test(`${name} page: StoragePanel loads and saves next to the page's own commands (one gated run)`, async () => {
      const r = await rig();
      r.fw.markDirty();
      r.render(el);
      assert.ok(await waitFor(loaded, 6000), `${name}: panel loaded (${storageStatus()} / ${storageError()})`);
      await sleep(400);
      const save = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === "Save to controller")[0];
      assert.ok(save);
      assert.ok(await waitFor(() => !isDisabled(save), 3000), `${name}: Save to controller becomes available; page: ${pageText().slice(600, 1600)}`);
      assert.ok(!pageText().includes("request not queued"), `${name}: the page's own first read was not refused by the panel`);
      click("Save to controller");
      assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000), `${name}: save result shown; log tail: ${r.fw.log.slice(-12).join(", ")}; status ${storageStatus()}`);
      assert.equal(storageError(), null);
      assert.equal(r.fw.count("save"), 1);
      assertContiguousSaves(r.fw.log);
      assert.equal(storageError(), null);
      assert.ok(!pageText().includes("Legacy/demo"));
      await r.done();
    });
  }

  await test("Ports page: its first read retries (bounded, busy only) while the gate's FIFO is full at mount, then loads; no busy text left on the page", async () => {
    const r = await rig();
    const held = r.holdGate(300, true);
    r.render(<PortsPage />);
    await held;
    assert.ok(await waitFor(loaded, 6000), `panel loaded (${storageStatus()} / ${storageError()})`);
    await sleep(300);
    assert.ok(!pageText().includes("request not queued"), `the page's first read was retried, not failed: ${pageText().slice(0, 600)}`);
    await r.done();
  });

  await test("Ports page: a first read that times out in the FIFO (isGateNotSent) says nothing was sent, is not retried and is not shown as an FC error", async () => {
    const r = await rig();
    const held = r.holdGate(GATE_QUEUE_TIMEOUT_MS + 400);
    r.render(<PortsPage />);
    assert.ok(await waitFor(() => pageText().includes(SNAPSHOT_NOT_SENT_TEXT), GATE_QUEUE_TIMEOUT_MS + 300), pageText().slice(0, 600));
    assert.ok(!/request not sent|timed out after/.test(pageText()), "the gate's raw text is never shown");
    await held; await sleep(100);
    assert.equal(r.fw.count("ports"), 0, "the timed-out read was not retried");
    await r.done();
  });

  // ---- #100 review round 2 -------------------------------------------------------------
  await test("S8: Save runs at WRITE priority: a Save clicked after a normal read is already waiting goes on the wire first", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(250);
    const mark = r.fw.log.length;
    const read = r.host.sendCommand("status");
    assert.equal(r.commands.queued, 1, "the read is waiting");
    click("Save to controller");
    assert.ok(await waitFor(() => r.commands.queued === 2, 1000), "the Save is waiting too");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
    await read; await held;
    assert.equal(storageError(), null);
    assert.deepEqual(r.fw.log.slice(mark), ["storage", "save", "storage", "status"], "write class overtakes the waiting normal read");
    await r.done();
  });

  await test("S12: a USB session change in the middle of a Save stops it: `save` never goes out on the new connection", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const client = (r.host as unknown as { client: { sendCommand(c: string, o?: unknown): Promise<string> } }).client;
    const orig = client.sendCommand.bind(client);
    let arm = true, reconnected = false;
    // The FC's reply to the Save's first `storage` arrives, then the USB link drops and comes back before the next line.
    client.sendCommand = async (c: string, o?: unknown) => {
      const res = await orig(c, o);
      if (c === "storage" && arm) {
        arm = false;
        await r.host.disconnect();
        await r.host.connect({ path: "sim://bobflight-storage", transport: "serial" });
        reconnected = r.host.getConnectionStatus() === "connected";
      }
      return res;
    };
    const mark = r.fw.log.length;
    click("Save to controller");
    assert.ok(await waitFor(() => reconnected, 3000), "the link came back");
    await sleep(400);
    client.sendCommand = orig;
    assert.equal(r.fw.log.slice(mark).filter((l) => l === "save").length, 0, `no save on the new connection: ${r.fw.log.slice(mark).join(", ")}`);
    assert.equal(r.fw.state, "dirty", "the FC never saved");
    await r.done();
  });

  /** Renders useConfigSnapshot alone over a scripted host (the hook's own error text). */
  function Probe({ sink }: { sink: (q: ReturnType<typeof useConfigSnapshot<string>>) => void }) {
    const q = useConfigSnapshot<string>("ports", (x) => x);
    sink(q);
    return <p data-testid="probe-error">{q.error}</p>;
  }
  await test("S16: an apply that went out, then a gate-rejected read-back: says the apply was sent but the read-back failed (never 'nothing sent', never raw gate text)", async () => {
    const r = await rig();
    let readbacks = 0;
    const fake = {
      getConnectionStatus: () => "connected",
      sendCommand: async (c: string) => {
        if (c === "ports") { if (readbacks++ === 0) return "ports-initial"; throw new GateQueueTimeoutError(GATE_QUEUE_TIMEOUT_MS); }
        if (c === "receiver_uart 2") return "receiver_uart: 2";
        throw new Error(`unexpected ${c}`);
      },
    };
    const realHost = r.ctx.host;
    r.ctx.host = fake;
    let q: ReturnType<typeof useConfigSnapshot<string>> | null = null;
    r.render(<Probe sink={(x) => { q = x; }} />);
    assert.ok(await waitFor(() => q?.snapshot === "ports-initial", 2000), "initial load");
    await q!.execute("receiver_uart 2" as CliCommand);
    await sleep(20); r.render(<Probe sink={(x) => { q = x; }} />);
    assert.equal(shown("probe-error"), SNAPSHOT_READBACK_NOT_SENT_TEXT);
    assert.ok(!/nothing was sent|request not sent|timed out/i.test(shown("probe-error") ?? ""));
    // And when the FIRST line was rejected, it is "nothing sent" (no raw text either).
    fake.sendCommand = async () => { throw new GateDisconnectedError(); };
    await q!.execute("receiver_uart 2" as CliCommand);
    await sleep(20); r.render(<Probe sink={(x) => { q = x; }} />);
    assert.equal(shown("probe-error"), SNAPSHOT_NOT_SENT_TEXT);
    r.unmount(); r.ctx.host = realHost;
    await r.done();
  });

  await test("S22/F5 panel: a NEWER schema (14) is 'could not be read' with the raw reply, never 'Fresh install'; a well-formed schema 12 is 'Fresh install required'", async () => {
    {
      const r = await rig();
      r.fw.replyOnce.set("storage", [r.fw.storageReply().replace("schema: 13", "schema: 14")]);
      r.render(<StoragePanel requiredScope="receiver_map" />);
      assert.ok(await waitFor(() => !!storageError()));
      assert.equal(storageError(), "The controller’s storage reply could not be read, so storage status is unknown.");
      assert.ok((shown("storage-error-detail") ?? "").includes("schema: 14"));
      assert.ok(!/Fresh install/i.test(pageText()));
      await r.done();
    }
    {
      const r = await rig();
      r.fw.replyOnce.set("storage", [r.fw.storageReply().replace("schema: 13", "schema: 12")]);
      r.render(<StoragePanel requiredScope="receiver_map" />);
      assert.ok(await waitFor(() => !!storageError()));
      assert.match(storageError() ?? "", /^Fresh install required: the controller reports storage schema 12/);
      await r.done();
    }
  });

  // F5 Rates tab: any failed `storage` read leaves capability unverified with the reason.
  const ratesCases: Array<[string, (r: Rig) => void, RegExp]> = [
    ["scope mismatch", (r) => r.fw.replyOnce.set("storage", [r.fw.storageReply().replace(/scope: [^\r]+/, "scope: pid_rates,receiver_uart")]), /^Storage capability unverified: Storage reply could not be read: scope does not match storage schema 13\. Saving is disabled\./],
    ["garbled reply", (r) => r.fw.replyOnce.set("storage", ["storage_api: 1\r\nb@ckend fl#sh\r\nstorage_end: 1\r\n"]), /^Storage capability unverified: Storage reply could not be read: .+\. Saving is disabled\./],
    ["newer schema 14", (r) => r.fw.replyOnce.set("storage", [r.fw.storageReply().replace("schema: 13", "schema: 14")]), /^Storage capability unverified: Storage reply could not be read: storage schema "14" is not schema 13\. Saving is disabled\./],
    ["queue timeout", (r) => { let armed = true; r.fw.onLine = (l) => { if (armed && l.startsWith("get ")) { armed = false; void r.holdGate(GATE_QUEUE_TIMEOUT_MS + 400); } }; },
      /^Storage capability unverified: another command was using the connection, so storage status was not read \(nothing was sent\)\. Saving is disabled\./],
  ];
  for (const [name, inject, want] of ratesCases) {
    await test(`F5 Rates tab: storage ${name} -> 'Storage capability unverified' + reason, never 'Fresh install required'; Save disabled`, async () => {
      const r = await rig();
      inject(r);
      r.render(<RatesPage />);
      const alert = () => container.findAll((e) => e.getAttribute("role") === "alert").map(visibleText).join(" | ");
      assert.ok(await waitFor(() => !!alert(), GATE_QUEUE_TIMEOUT_MS + 3000), `an alert is shown: ${pageText().slice(0, 300)}`);
      assert.match(alert(), want);
      assert.ok(!/Fresh install/i.test(pageText()), pageText().slice(0, 400));
      assert.ok(!/request not sent/.test(pageText()));
      assert.ok(isDisabled(button("Save to controller")));
      r.fw.onLine = null;
      await sleep(GATE_QUEUE_TIMEOUT_MS > 0 && name === "queue timeout" ? 600 : 0);
      await r.done();
    });
  }
  await test("F5 Rates tab: a well-formed OLDER schema (12) read from the FC is the one case that says 'Fresh install required'", async () => {
    const r = await rig();
    r.fw.replyOnce.set("storage", [r.fw.storageReply().replace("schema: 13", "schema: 12")]);
    r.render(<RatesPage />);
    assert.ok(await waitFor(() => /Fresh install required/.test(pageText()), 4000), pageText().slice(0, 300));
    assert.match(pageText(), /Fresh install required: the controller reports storage schema 12; this Configurator needs storage schema 13\. Actual rates need storage schema 13\./);
    assert.ok(!/unverified/i.test(pageText()));
    await r.done();
  });
  await test("F5 Rates tab: a good schema-13 reply loads (no unverified / Fresh install text)", async () => {
    const r = await rig();
    r.render(<RatesPage />);
    await sleep(800);
    assert.ok(!/unverified|Fresh install|could not be read/i.test(pageText()), pageText().slice(0, 400));
    await r.done();
  });

  await test("S24: a quiet re-read (page unblocked) that stays busy shows NO error and keeps the shown status", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(loaded));
    const text = storageStatus();
    r.render(<StoragePanel requiredScope="receiver_map" blocked={true} />);
    await sleep(20);
    const held = r.holdGate(4500, true);
    const before = r.gate.refused;
    r.render(<StoragePanel requiredScope="receiver_map" blocked={false} />);
    assert.ok(await waitFor(() => r.gate.refused - before > STORAGE_BUSY_RETRIES, 4400), "the quiet re-read really ran out of busy retries");
    await sleep(60);
    assert.equal(storageError(), null, "busy on a quiet re-read is silent");
    assert.equal(storageStatus(), text, "the shown status stands");
    await held; await r.done();
  });

  for (const [what, set] of [["armed", (fw: MockStorageFirmware) => { fw.armed = true; }], ["bench active", (fw: MockStorageFirmware) => { fw.benchActive = true; }],
    ["calibrating", (fw: MockStorageFirmware) => { fw.calibrationActive = true; }]] as const) {
    await test(`S27 (safety): the Save's own pre-save storage read refuses to save while the FC is ${what} (state changed after the panel loaded): no save line`, async () => {
      const r = await rig();
      r.render(<StoragePanel requiredScope="receiver_map" />);
      assert.ok(await waitFor(loaded));
      r.fw.markDirty();
      r.render(<StoragePanel requiredScope="receiver_map" revision={0} />);
      assert.ok(!isDisabled(button("Save to controller")), "Save enabled from the last (disarmed) read");
      set(r.fw);
      const mark = r.fw.log.length;
      click("Save to controller");
      assert.ok(await waitFor(() => !!storageError(), 3000));
      assert.match(storageError() ?? "", /^Flash save unavailable: disarm, stop motors and calibration/);
      assert.ok(!r.fw.log.slice(mark).includes("save"), `no save line: ${r.fw.log.slice(mark).join(", ")}`);
      assert.equal(r.fw.state, "dirty");
      await r.done();
    });
  }

  await test("S5: a Save the FC answers 'verified' but whose read-back is not saved is an error (not shown as saved)", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    r.fw.afterReply = (l) => { if (l === "save") { r.fw.afterReply = null; r.fw.replyOnce.set("storage", [r.fw.storageReply().replace("state: saved", "state: dirty").replace("dirty: 0", "dirty: 1")]); } };
    click("Save to controller");
    assert.ok(await waitFor(() => !!storageError() || /Saved to controller/.test(shown("storage-message") ?? ""), 3000));
    assert.equal(storageError(), "The controller replied “saved” but its storage status does not read back as saved.");
    assert.ok(!/Saved to controller flash and verified/.test(pageText()));
    await r.done();
  });

  console.log(`PASS StoragePanel gated load/save (real gate): ${passed} tests`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
