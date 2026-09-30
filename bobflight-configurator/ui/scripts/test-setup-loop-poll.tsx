/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for the real SetupPage (react-dom in a minimal fake DOM; useHost
 * stubbed by run-setup-loop-poll.mjs). QA FAIL on #57: when Setup mounted while
 * another command held the shared CommandGate, the automatic loop_rate_hz read
 * was refused within one tick, busy went true -> false in a single render and
 * the loop-rate status poll (disabled by pauseLoopPoll) never restarted. The
 * poll must start once the other command completes.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { SetupPage } from "../src/pages/SetupPage";
import { CommandGate } from "../src/protocol/commandGate";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { LOOP_LABELS } from "../../protocol/src/loop-rate";
import type { CliCommand } from "../src/protocol/types";

const { container } = installFakeDom();
/** Open Setup like the nav click does: a discrete (SyncLane) render, whose passive
 * effects React 18 flushes synchronously at commit. The busy=true render the
 * automatic setting read schedules then lands in a later task, after the busy
 * gate's instant refusal already set busy back to false (true -> false batched). */
function openSetup(root: Root) { flushSync(() => root.render(<SetupPage />)); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}
/** Value of the Setup status card whose label is `label` ("" if absent). */
function card(label: string): string {
  const el = container.findAll((e) => (e.getAttribute("class") ?? "").split(" ").includes("status-card"))
    .find((c) => (c.childNodes[0] as FakeElement | undefined)?.textContent === label);
  return el ? (el.childNodes[1] as FakeElement).textContent : "";
}

/** Real CommandGate (as in createHost) around the UI mock host (Kakute 8000/2 scenario). */
async function rig() {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "8000/2" });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const gate = new CommandGate(() => 1);
  const sent: string[] = [];
  const refused: string[] = [];
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    sendCommand: (cmd: CliCommand) => gate.run(async () => { sent.push(cmd); return mock.sendCommand(cmd); })
      .catch((e: unknown) => { refused.push(cmd); throw e; }),
    saveSettings: () => gate.run(() => mock.saveSettings()),
    restoreDefaults: () => gate.run(() => mock.restoreDefaults()),
  };
  (globalThis as Record<string, unknown>).__setupTestHost = {
    host, connectionStatus: "connected", version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
  };
  return { mock, gate, sent, refused };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await test("Setup mounted while another command is in flight: the loop-rate poll starts once it completes (QA #57)", async () => {
    const { gate, sent, refused, mock } = await rig();
    const other = deferred();
    const inFlight = gate.run(() => other.promise); // e.g. a Sensors poll still holding the gate
    const root: Root = createRoot(container as never);
    openSetup(root);
    await sleep(300);
    assert.ok(refused.includes("get loop_rate_hz"), `the automatic setting read was refused by the busy gate: ${JSON.stringify(refused)}`);
    assert.equal(sent.length, 0, `nothing reached the FC while the other command held the gate: ${JSON.stringify(sent)}`);
    other.resolve(); await inFlight;
    const started = await waitFor(() => sent.includes("status"), 2500);
    assert.ok(started, `loop-rate status poll must start after the in-flight command completes; sent=${JSON.stringify(sent)} refused=${JSON.stringify(refused)}`);
    assert.ok(await waitFor(() => card(LOOP_LABELS.target) === "4000", 1500), `target card shows the FW value: "${card(LOOP_LABELS.target)}"`);
    assert.equal(card(LOOP_LABELS.actual), "3998");
    root.unmount(); await mock.disconnect();
  });
  await test("control: Setup mounted on an idle gate polls status and reads the setting", async () => {
    const { sent, mock } = await rig();
    const root: Root = createRoot(container as never);
    openSetup(root);
    assert.ok(await waitFor(() => sent.includes("status") && sent.includes("get loop_rate_hz"), 2500), JSON.stringify(sent));
    assert.ok(await waitFor(() => card("Selected (controller RAM)") === "4 kHz" && card("Applied at boot") === "4 kHz", 1500),
      `${card("Selected (controller RAM)")} / ${card("Applied at boot")}`);
    root.unmount(); await mock.disconnect();
  });
  console.log(`PASS Setup loop-rate poll render: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 20000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exitCode = 1; });
