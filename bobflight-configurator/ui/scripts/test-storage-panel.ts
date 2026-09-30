/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REFRESH_CONFIRM_MESSAGE, requestRefresh, shouldConfirmRefresh, storageDirty, browserConfirm } from "../src/components/storageRefresh";
import { parseStorage, STORAGE_SCOPE_V6 } from "../../protocol/src/storage";
import { BenchController, type BenchState } from "../src/motors/benchController";
import { storageBlocked } from "../src/motors/motorsStorage";
import type { CliCommand, ConnectionStatus, ParsedStatus } from "../src/protocol/types";
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
function harness(answer: boolean) {
  const prompts: string[] = []; let refreshes = 0;
  return {
    prompts, refreshes: () => refreshes,
    confirm: (message: string) => { prompts.push(message); return answer; },
    refresh: () => { refreshes++; },
  };
}
// Controller `storage` status reply (same shape the firmware emits).
const storageReply = (dirty: 0 | 1) => [
  "storage_api: 1", "backend: flash", "schema: 6", `state: ${dirty ? "dirty" : "saved"}`, `dirty: ${dirty}`,
  "generation: 3", "last_error: none", `scope: ${STORAGE_SCOPE_V6}`, "armed: 0", "bench_active: 0",
  "calibration_active: 0", "flight_enabled: 0", "storage_end: 1",
].join("\r\n") + "\r\n";
// Same FakeHost pattern as test-motor-bench.ts: healthy disarmed bench firmware, honest empty eRPM.
const ready: ParsedStatus = { raw: "", board: "test", arm: "disarmed", mmio: "allowed", dshot_bound: "4/4", motor_output: "DShot300 ready", failClosed: true, failClosedReasons: ["bench firmware: flight arming disabled"] };
class FakeHost {
  commands: string[] = [];
  connection: ConnectionStatus = "connected";
  getConnectionStatus() { return this.connection; }
  async getStatus() { this.commands.push("status"); return { ...ready }; }
  async sendCommand(cmd: CliCommand) {
    this.commands.push(cmd);
    if (cmd === "help") return "  motor_pulse <1..4> <0..100>\n  motor_test <0..4>\n  motor_seq - sequence\n  dshot [300|600]";
    if (cmd === "dshot") return "dshot: 300 kbps";
    if (/^get erpm_m[1-4]$/.test(cmd)) return `${cmd.slice(4)}=none\r\n`;
    if (/^get dshot_telem_m[1-4]$/.test(cmd)) return "none\r\n";
    return "motor test accepted (one second maximum)\r\n";
  }
}

async function main() {
  await test("dirty: confirm shown with exact copy before any reload", () => {
    assert.equal(REFRESH_CONFIRM_MESSAGE, "Reload from FC? Unsaved changes will be lost");
    assert.equal(shouldConfirmRefresh(true), true);
    const h = harness(true);
    requestRefresh({ dirty: true, confirm: h.confirm, refresh: () => { assert.equal(h.prompts.length, 1, "confirm must come first"); h.refresh(); } });
    assert.deepEqual(h.prompts, ["Reload from FC? Unsaved changes will be lost"]);
    assert.equal(h.refreshes(), 1);
  });
  await test("dirty + cancel: nothing happens (no refresh)", () => {
    const h = harness(false);
    assert.equal(requestRefresh({ dirty: true, confirm: h.confirm, refresh: h.refresh }), false);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.refreshes(), 0);
  });
  await test("dirty + confirm: refresh called exactly once", () => {
    const h = harness(true);
    assert.equal(requestRefresh({ dirty: true, confirm: h.confirm, refresh: h.refresh }), true);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.refreshes(), 1);
  });
  await test("clean: no confirm, refresh immediately", () => {
    assert.equal(shouldConfirmRefresh(false), false);
    const h = harness(false);
    assert.equal(requestRefresh({ dirty: false, confirm: h.confirm, refresh: h.refresh }), true);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.refreshes(), 1);
  });
  await test("dirty signal is the controller storage report (unknown = clean)", () => {
    assert.equal(storageDirty(parseStorage(storageReply(1))), true);
    assert.equal(storageDirty(parseStorage(storageReply(0))), false);
    assert.equal(storageDirty(null), false);
    assert.equal(storageDirty(undefined), false);
    const h = harness(false);
    requestRefresh({ dirty: storageDirty(parseStorage(storageReply(1))), confirm: h.confirm, refresh: h.refresh });
    assert.equal(h.refreshes(), 0);
    requestRefresh({ dirty: storageDirty(parseStorage(storageReply(0))), confirm: h.confirm, refresh: h.refresh });
    assert.equal(h.refreshes(), 1);
    assert.equal(h.prompts.length, 1);
  });
  await test("default confirm is window.confirm; no window means no silent reload", () => {
    assert.equal(browserConfirm(REFRESH_CONFIRM_MESSAGE), false);
    const g = globalThis as { window?: unknown };
    const asked: string[] = [];
    g.window = { confirm: (m: string) => { asked.push(m); return true; } };
    try {
      assert.equal(browserConfirm(REFRESH_CONFIRM_MESSAGE), true);
      assert.deepEqual(asked, [REFRESH_CONFIRM_MESSAGE]);
    } finally { delete g.window; }
  });
  await test("StoragePanel wires Refresh through the guard with low-emphasis styling", () => {
    const button = source("../src/components/StoragePanel.tsx").split("\n").find(line => line.includes(">Refresh storage</button>")) ?? "";
    assert.match(button, /className="ghost"/);
    assert.match(button, /requestRefresh\(\{dirty:storageDirty\(state\),confirm:browserConfirm,refresh:\(\)=>void run\('refresh'\)\}\)/);
    assert.doesNotMatch(button, /onClick=\{\(\)=>void run\('refresh'\)\}/);
  });
  await test("Motors flicker lock: read-only poll toggles busy, never actionPending; StoragePanel blocked stays false", async () => {
    const host = new FakeHost(); let now = 100;
    const c = new BenchController(host, () => now);
    const seen: BenchState[] = [];
    c.subscribe(s => { seen.push(s); });
    c.connection(true);
    for (let i = 0; i < 6; i++) {
      const before = seen.length;
      await c.poll(); now += 500;
      assert.ok(seen.slice(before).some(s => s.busy), `poll ${i} must set busy`);
      assert.equal(c.state.busy, false, `poll ${i} must clear busy`);
    }
    assert.ok(host.commands.includes("get erpm_m4"), "poll cycles really ran");
    const busyEdges = seen.filter((s, k) => k > 0 && s.busy !== seen[k - 1].busy).length;
    assert.equal(busyEdges, 12, "busy toggles on and off once per poll");
    assert.ok(seen.every(s => !s.actionPending && !s.stopping), "read-only poll never sets actionPending/stopping");
    assert.ok(seen.every(s => storageBlocked(s) === false), "StoragePanel blocked stays false across polls");
    assert.equal(storageBlocked({ ...c.state, busy: true }), false, "busy alone never blocks StoragePanel");
  });
  await test("Motors storage panel still blocks during a real bench action and a stop", async () => {
    const host = new FakeHost(); let now = 100;
    const c = new BenchController(host, () => now);
    const seen: BenchState[] = [];
    c.subscribe(s => { seen.push(s); });
    c.connection(true); await c.poll(); c.confirmProps(true); c.confirmStationary(true);
    seen.length = 0; await c.start(1);
    assert.ok(host.commands.includes("motor_test 1"));
    assert.ok(seen.some(s => s.actionPending && storageBlocked(s)), "user action blocks StoragePanel");
    assert.equal(storageBlocked(c.state), false);
    seen.length = 0; await c.stop();
    assert.ok(seen.some(s => s.stopping && storageBlocked(s)), "stop blocks StoragePanel");
    assert.equal(storageBlocked(c.state), false);
  });
  await test("MotorsPage passes storageBlocked(state) to StoragePanel, never state.busy", () => {
    const panel = source("../src/pages/MotorsPage.tsx").match(/<StoragePanel\b[^>]*\/>/g) ?? [];
    assert.equal(panel.length, 1, "MotorsPage renders one StoragePanel");
    assert.match(panel[0], /blocked=\{storageBlocked\(state\)\}/);
    assert.doesNotMatch(panel[0], /busy/);
  });
  console.log(`${passed} storage-panel tests passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
