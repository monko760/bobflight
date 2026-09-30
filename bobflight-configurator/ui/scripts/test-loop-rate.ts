/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Setup loop-rate readout: poller (adapted from the Configurator Lead's TimingPoller tests), UI mocks and wiring. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LoopRatePoller, LOOP_RATE_POLL_MS, LOOP_RATE_MAX_SKIPS } from "../src/setup/loopRatePoller";
import { parseLoopStatus, loopRateView, LOOP_LABELS } from "../../protocol/src/loop-rate";
import { mockLoopStatusLines, LOOP_RATE_MOCK_SCENARIOS, type LoopRateMockScenario } from "../../protocol/src/loop-rate-mock";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { parseCliInput } from "../src/protocol/types";
import { storageBlocked } from "../src/motors/motorsStorage";
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** Source without comments, so doc text cannot satisfy or trip a wiring check. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (t: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
class FakeTimers {
  pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  set = (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; this.pending.push(t); return t; };
  clear = (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; };
  live() { return this.pending.filter(t => !t.cleared); }
  async tick() { const due = this.live(); this.pending = []; for (const t of due) t.fn(); await flush(); }
}
const statusReply = (scenario: LoopRateMockScenario) => ["board: kakute_f7_hdv", "arm: disarmed", ...mockLoopStatusLines(scenario)].join("\r\n");
function rig(scenario: LoopRateMockScenario = "8000/2") {
  const timers = new FakeTimers(); const sent: string[] = [];
  const host = { scenario, next: null as null | Promise<string>, send: async () => { sent.push("status"); return host.next ?? statusReply(host.scenario); } };
  const poller = new LoopRatePoller(() => host.send(), () => {}, timers);
  return { timers, sent, host, poller };
}
const values = (p: LoopRatePoller) => loopRateView(p.state.raw === null ? null : parseLoopStatus(p.state.raw)).items.map(i => i.value);
const rejected = (msg: string) => { const p = Promise.reject(new Error(msg)); p.catch(() => {}); return p; };

async function main() {
  await test("polls read-only status only while enabled, at 1 s", async () => {
    const { timers, sent, poller } = rig();
    await timers.tick(); assert.deepEqual(sent, []);
    poller.setEnabled(true); await flush();
    assert.deepEqual(sent, ["status"]); assert.equal(LOOP_RATE_POLL_MS, 1000);
    assert.deepEqual(timers.live().map(t => t.ms), [LOOP_RATE_POLL_MS]);
    await timers.tick(); await timers.tick(); assert.equal(sent.length, 3);
    assert.deepEqual(values(poller), ["4000", "3998", "9007199254740993"]);
    assert.equal(parseCliInput("status"), "status", "status is an allowed read-only command");
  });
  await test("an action pauses polling, then it resumes", async () => {
    const { timers, sent, poller } = rig();
    poller.setEnabled(true); await flush(); poller.setEnabled(false);
    assert.equal(timers.live().length, 0); await timers.tick(); assert.equal(sent.length, 1);
    poller.setEnabled(true); await flush(); assert.equal(sent.length, 2);
  });
  await test("one request at a time; a reply from an older epoch is dropped; idle() waits", async () => {
    const { timers, sent, host, poller } = rig("1000/1");
    const d = deferred<string>(); host.next = d.promise;
    poller.setEnabled(true); await flush();
    poller.setEnabled(false); poller.setEnabled(true); await flush();
    assert.equal(sent.length, 1, "never queued behind the in-flight read");
    let idle = false; void poller.idle().then(() => { idle = true; }); await flush(); assert.equal(idle, false);
    host.next = null; d.resolve(statusReply("8000/2")); await flush(); assert.equal(idle, true);
    assert.equal(poller.state.raw, null, "stale-epoch reply dropped");
    await timers.tick(); assert.deepEqual(values(poller), ["1000", "999", "1"]);
  });
  await test("gate refusal is transient for a few polls, then the stale reading is dropped; real errors clear it", async () => {
    const { host, poller, timers } = rig();
    poller.setEnabled(true); await flush(); const good = poller.state.raw; assert.notEqual(good, null);
    for (let i = 1; i < LOOP_RATE_MAX_SKIPS; i++) {
      host.next = rejected("another UI command is in flight; request not queued"); await timers.tick();
      assert.equal(poller.state.raw, good); assert.equal(poller.state.error, "");
    }
    host.next = rejected("another UI command is in flight; request not queued"); await timers.tick();
    assert.equal(poller.state.raw, null, "never shows a rate older than ~3 s as current");
    assert.deepEqual(values(poller), ["unknown", "unknown", "unknown"]);
    host.next = null; await timers.tick(); assert.notEqual(poller.state.raw, null);
    host.next = rejected("Timeout waiting for response"); await timers.tick();
    assert.equal(poller.state.raw, null); assert.match(poller.state.error, /Timeout/);
    host.next = null; await timers.tick(); poller.setEnabled(false); poller.reset();
    assert.deepEqual(poller.state, { raw: null, error: "" });
  });
  await test("UI MockBobFlightHost scenarios 1000/1, 8000/2, unavailable, missing (older FC)", async () => {
    const expected: Record<LoopRateMockScenario, string[]> = {
      "missing": ["unknown", "unknown", "unknown"], "1000/1": ["1000", "999", "1"],
      "8000/2": ["4000", "3998", "9007199254740993"], "unavailable": ["4000", "unknown", "0"],
    };
    assert.deepEqual(Object.keys(expected).sort(), [...LOOP_RATE_MOCK_SCENARIOS].sort());
    for (const scenario of LOOP_RATE_MOCK_SCENARIOS) {
      const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: scenario === "missing" ? undefined : scenario });
      await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
      const timers = new FakeTimers();
      const poller = new LoopRatePoller(() => host.sendCommand("status"), () => {}, timers);
      poller.setEnabled(true); await flush(); await poller.idle(); await flush();
      assert.deepEqual(values(poller), expected[scenario], scenario);
      const view = loopRateView(parseLoopStatus(poller.state.raw ?? ""));
      if (scenario === "missing") assert.match(view.notice ?? "", /older FC/);
      if (scenario === "unavailable") assert.match(view.notice ?? "", /still measuring/);
      assert.ok((await host.getStatus()).loop, "legacy loop: line still parsed");
      poller.setEnabled(false); await host.disconnect();
    }
    const host = new MockBobFlightHost({ connectDelayMs: 0 });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    host.setMockGates({ loopRateScenario: "8000/2" });
    assert.equal(parseLoopStatus(await host.sendCommand("status")).overruns, "9007199254740993");
    await host.disconnect();
  });
  await test("readout wiring: frozen keys only, no hardcoded or computed target, no Number() on overruns", () => {
    const setup = source("../src/pages/SetupPage.tsx");
    const parser = source("../../protocol/src/loop-rate.ts");
    const poller = source("../src/setup/loopRatePoller.ts");
    for (const [name, text] of [["SetupPage", code(setup)], ["loop-rate.ts", code(parser)]] as const) {
      assert.doesNotMatch(text, /\b(1000|2000|4000|8000)\b/, `${name}: no hardcoded loop rates`);
      assert.doesNotMatch(text, /\bNumber\(|parseInt|parseFloat|\bdenom\b.*\//, `${name}: no numeric conversion or target math`);
    }
    assert.deepEqual(poller.split("\n").filter(l => /\b1000\b/.test(l)), ["export const LOOP_RATE_POLL_MS = 1000;"], "only the 1 s poll period");
    assert.match(parser, /"loop_target_hz"/); assert.match(parser, /"loop_actual_hz"/); assert.match(parser, /"loop_overruns"/);
    assert.equal(LOOP_LABELS.actual, "Loop actual (Hz, last ~1 s)"); assert.doesNotMatch(LOOP_LABELS.actual, /since boot/);
    assert.match(setup, /loopRateView\(loopPoll\.raw === null \? null : parseLoopStatus\(loopPoll\.raw\)\)/);
    assert.match(setup, /new LoopRatePoller\(\(\) => host\.sendCommand\("status"\), setLoopPoll\)/);
    assert.match(setup, /loopPoller\.setEnabled\(connected && !busy && !postFlashGate\)/);
    assert.equal((setup.match(/await pauseLoopPoll\(\);/g) ?? []).length, 2, "Refresh and Restore defaults pause the poll first");
  });
  await test("status poll never feeds shared status or StoragePanel blocked; PR #54 Motors lock intact", () => {
    const setup = source("../src/pages/SetupPage.tsx");
    const pollerSrc = code(source("../src/setup/loopRatePoller.ts"));
    assert.doesNotMatch(setup, /<StoragePanel|import[^;]*StoragePanel/, "Setup renders no StoragePanel");
    assert.doesNotMatch(pollerSrc, /refreshStatus|setStatus|useHost|StoragePanel|blocked=/);
    assert.doesNotMatch(setup.slice(setup.indexOf("new LoopRatePoller"), setup.indexOf("async function pauseLoopPoll")), /refreshStatus|setStatus/);
    for (const f of ["../src/components/StoragePanel.tsx", "../src/motors/motorsStorage.ts", "../src/pages/MotorsPage.tsx"]) {
      assert.doesNotMatch(code(source(f)), /loopRate|LoopRate|loopPoll/i, `${f} untouched by the loop-rate poll`);
    }
    assert.match(source("../src/pages/MotorsPage.tsx"), /blocked=\{storageBlocked\(state\)\}/);
    assert.equal(storageBlocked({ actionPending: false, stopping: false }), false);
    assert.equal(storageBlocked({ actionPending: true, stopping: false }), true);
    assert.equal(storageBlocked({ actionPending: false, stopping: true }), true);
    assert.doesNotMatch(code(source("../src/motors/motorsStorage.ts")).split("export function")[1], /busy/, "busy never reaches blocked");
  });
  await test("CI runs the loop-rate tests and the firmware contract", () => {
    const ci = source("../../../.github/workflows/ci.yml");
    for (const step of ["npm --prefix protocol run test:loop-rate", "npm --prefix ui run test:loop-rate", "node ../.github/scripts/loop-status-contract.cjs", "npm --prefix ui run test:storage"])
      assert.ok(ci.includes(step), step);
  });
  console.log(`PASS setup loop-rate UI: ${passed} tests`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
