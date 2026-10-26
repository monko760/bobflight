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
import { STORAGE_BUSY_TEXT, STORAGE_BUSY_RETRIES, STORAGE_BUSY_RETRY_MS, runStorageGated, StorageBusyError } from "../src/components/storageSequence";
import { ReceiverPage } from "../src/pages/ReceiverPage";
import { PowerBatteryPage } from "../src/pages/PowerBatteryPage";
import { SensorsPage } from "../src/pages/SensorsPage";
import { ModesPage } from "../src/pages/ModesPage";
import { PortsPage } from "../src/pages/PortsPage";
import { MotorsPage } from "../src/pages/MotorsPage";
import { createHostWithTransport } from "../src/protocol/createHost";
import { isGateBusy, GATE_BUSY_MESSAGE } from "../src/protocol/commandGate";
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
  /** runStorageSequence calls (gate attempts) and how many the gate refused. */
  gate: { attempts: number; refused: number };
  /** Holds the REAL CommandGate (as another page's slow command would) for `ms`. */
  holdGate(ms: number): Promise<unknown>;
  done(): Promise<void>;
}
async function rig(o: StorageSimOptions = {}): Promise<Rig> {
  const fw = new MockStorageFirmware(o);
  const host = createHostWithTransport(new StorageSimTransportFactory(fw));
  await host.connect({ path: "sim://bobflight-storage", transport: "serial" });
  assert.equal(host.getConnectionStatus(), "connected");
  const gate = { attempts: 0, refused: 0 };
  const real = host.runStorageSequence!.bind(host);
  host.runStorageSequence = <T,>(work: Parameters<typeof real>[0]) => {
    gate.attempts++;
    return (real(work) as Promise<T>).catch((e) => { if (isGateBusy(e)) gate.refused++; throw e; });
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
    fw, host, ctx, gate,
    render(el) { current = el; if (!root) root = createRoot(container as never); rerender(); },
    unmount() { if (root) { root.unmount(); root = null; } current = null; },
    holdGate: (ms) => host.runStorageSequence!(() => sleep(ms)).catch((e) => e),
    async done() { if (root) root.unmount(); root = null; await host.disconnect(); await sleep(10); },
  };
}

/** An independent poller on the real gate, as another page's telemetry loop: `status` every `periodMs`, never overlapping itself. */
function poller(host: Rig["host"], periodMs: number) {
  const stats = { ok: 0, busy: 0, other: [] as string[] };
  let inflight = false;
  const t = setInterval(() => {
    if (inflight) return;
    inflight = true;
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
    console.log(`  200 ms poller: ${res.saves}/20 saves, ${res.failures.length} failures; poller ok ${res.poller.ok} busy ${res.poller.busy}; panel gate attempts ${res.gate.attempts} refused ${res.gate.refused}`);
    assert.deepEqual(res.failures, []);
    assert.equal(res.saves, 20);
    assert.deepEqual(res.poller.other, [], "the poller never saw a non-busy error (no client overlap)");
    assert.ok(res.poller.ok >= 1 && res.poller.ok + res.poller.busy > 5, "the poller really ran");
  });

  await test("20 mount+save cycles next to a 50 ms poller on the real gate: 0 load/save failures, busy refusals retried, every save one contiguous gated run", async () => {
    const res = await cycles(50);
    console.log(`  50 ms poller: ${res.saves}/20 saves, ${res.failures.length} failures; poller ok ${res.poller.ok} busy ${res.poller.busy}; panel gate attempts ${res.gate.attempts} refused ${res.gate.refused}`);
    assert.deepEqual(res.failures, []);
    assert.equal(res.saves, 20);
    assert.deepEqual(res.poller.other, []);
    assert.ok(res.gate.refused > 0, "the 50 ms poller really contended for the gate (the panel retried)");
    assert.ok(res.poller.busy > 0, "the panel's gated runs really held the gate against the poller");
  });

  await test("Save is ONE gated run: competing commands tried on every microtask after each reply of the sequence are all refused; nothing reaches the FC between storage, save, storage", async () => {
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
    assert.ok(outcomes.filter((o) => o === "busy").length >= 400, `competing commands were really tried (${outcomes.length})`);
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

  await test("bounded busy retry: a gate held 5 s gives up after 1+" + STORAGE_BUSY_RETRIES + " attempts (~3 s) with plain text + the raw refusal; nothing sent", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(5000);
    const sentBefore = r.fw.log.length, attemptsBefore = r.gate.attempts, t0 = Date.now();
    click("Save to controller");
    assert.ok(await waitFor(() => !!storageError(), 5000), "gave up while the gate was still held");
    const elapsed = Date.now() - t0;
    assert.equal(storageError(), STORAGE_BUSY_TEXT.save);
    assert.equal(storageError(), "Another command was using the connection, so nothing was saved. Try Save to controller again.");
    assert.equal(shown("storage-error-detail"), `Connection reply: ${GATE_BUSY_MESSAGE}`);
    assert.equal(r.gate.attempts - attemptsBefore, STORAGE_BUSY_RETRIES + 1, "exactly 1 + retries panel attempts");
    assert.ok(elapsed >= STORAGE_BUSY_RETRIES * STORAGE_BUSY_RETRY_MS * 0.9 && elapsed < 4800, `bounded (~3 s): ${elapsed} ms`);
    assert.deepEqual(r.fw.log.slice(sentBefore), [], "nothing reached the FC");
    assert.match(storageStatus(), /^Controller flash · saved · /, "busy keeps the last verified status (nothing was read)");
    assert.ok(!pageText().includes("Legacy/demo"));
    await held;
    await r.done();
  });

  await test("busy for a moment, then free: the Save retries and succeeds with one save line", async () => {
    const r = await rig();
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded));
    r.fw.markDirty();
    const held = r.holdGate(250);
    const attemptsBefore = r.gate.attempts;
    click("Save to controller");
    assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(shown("storage-message") ?? "") || !!storageError(), 4000));
    assert.equal(storageError(), null);
    assert.ok(r.gate.attempts - attemptsBefore > 2, "the panel retried while the gate was busy");
    assert.equal(r.fw.count("save"), 1);
    await held; await r.done();
  });

  await test("busy initial load (another page holds the gate at mount) retries and loads", async () => {
    const r = await rig();
    const held = r.holdGate(200);
    r.render(<StoragePanel requiredScope="receiver_map" />);
    assert.ok(await waitFor(loaded, 3000));
    assert.equal(storageError(), null);
    assert.ok(r.gate.refused > 0);
    await held; await r.done();
  });

  await test("bounded retry helper by behaviour: never retries a non-busy error, retries are counted and capped", async () => {
    let calls = 0;
    const fwErr = { sendCommand: async () => "", runStorageSequence: async () => { calls++; throw new Error("save failed: error"); } };
    await assert.rejects(runStorageGated(fwErr as never, "save", async () => 1, { sleep: async () => {} }), /save failed: error/);
    assert.equal(calls, 1);
    calls = 0;
    const busy = { sendCommand: async () => "", runStorageSequence: async () => { calls++; throw new Error(GATE_BUSY_MESSAGE); } };
    await assert.rejects(runStorageGated(busy as never, "refresh", async () => 1, { retries: 7, sleep: async () => {} }), (e) => e instanceof StorageBusyError && e.attempts === 8);
    assert.equal(calls, 8);
    // Line-by-line host (no gated run): a refusal after a line already went out is not retried.
    calls = 0;
    const lineHost = { sendCommand: async (c: CliCommand) => { calls++; if (c === "save") throw new Error(GATE_BUSY_MESSAGE); return "x"; } };
    await assert.rejects(runStorageGated(lineHost as never, "save", async (send) => { await send("storage"); return send("save"); }, { sleep: async () => {} }), StorageBusyError);
    assert.equal(calls, 2, "storage then a refused save; the sequence is not replayed");
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
    const held = r.holdGate(400); await held; await sleep(30);
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

  console.log(`PASS StoragePanel gated load/save (real gate): ${passed} tests`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
