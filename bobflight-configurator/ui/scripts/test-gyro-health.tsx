/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Setup gyro sanity readout (FW `status` gyro_health / gyro_sat_count).
 * renderToStaticMarkup for the cards, plus the real SetupPage in the fake DOM
 * (useHost stubbed by run-gyro-health.mjs) driven by the UI mock host.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { SetupPage } from "../src/pages/SetupPage";
import { GyroHealthCards } from "../src/setup/GyroHealthCards";
import { CommandGate } from "../src/protocol/commandGate";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { parseStatus } from "../src/protocol/parseStatus";
import { shouldDisableArm } from "../src/protocol";
import {
  GYRO_HEALTH_MOCK_SCENARIOS, GYRO_HEALTH_MOCK_BIG_SAT, GYRO_HEALTH_MOCK_FUTURE_TOKEN, mockGyroHealthLines,
  type GyroHealthMockScenario,
} from "../../protocol/src/gyro-health";
import type { CliCommand } from "../src/protocol/types";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); } catch (e) { console.log(`FAIL ${name}`); throw e; }
  passed++; console.log(`PASS ${name}`);
}

/** Visible text of the value cell for `key` in static markup (hidden spans would not be stripped). */
function staticValue(html: string, key: string): string {
  const m = new RegExp(`<div class="v" data-gyro-health="${key}">(.*?)</div>`).exec(html);
  assert.ok(m, `value cell ${key} rendered: ${html}`);
  return m[1];
}
function statusRaw(lines: string[]): string {
  return ["board: kakute_f7_hdv", "gyro_ok: yes", ...lines, "gyro_bind: mpu6000", "arm: disarmed", "failsafe: ok"].join("\r\n");
}

const EXPECT: Record<GyroHealthMockScenario, [string, string]> = {
  missing: ["unknown", "unknown"],
  ok: ["ok", "0"],
  stuck: ["stuck", "3"],
  "whoami-mismatch": ["whoami-mismatch", "0"],
  "config-lost": ["config-lost", "12"],
  "unknown-token": [GYRO_HEALTH_MOCK_FUTURE_TOKEN, "7"],
  "sat-big": ["ok", GYRO_HEALTH_MOCK_BIG_SAT],
};

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}
function cards(): FakeElement[] {
  return container.findAll((e) => (e.getAttribute("class") ?? "").split(" ").includes("status-card"));
}
function card(label: string): string {
  const el = cards().find((c) => (c.childNodes[0] as FakeElement | undefined)?.textContent === label);
  return el ? (el.childNodes[1] as FakeElement).textContent : "";
}
function cardLabels(): string[] { return cards().map((c) => (c.childNodes[0] as FakeElement).textContent); }

async function rig(scenario: GyroHealthMockScenario, connectionStatus = "connected") {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, loopRateScenario: "8000/2", gyroHealthScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const gate = new CommandGate(() => 1);
  const sent: string[] = [];
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    sendCommand: (cmd: CliCommand) => gate.run(async () => { sent.push(cmd); return mock.sendCommand(cmd); }),
    saveSettings: () => gate.run(() => mock.saveSettings()),
    restoreDefaults: () => gate.run(() => mock.restoreDefaults()),
  };
  (globalThis as Record<string, unknown>).__setupTestHost = {
    host, connectionStatus, version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
  };
  const root: Root = createRoot(container as never);
  flushSync(() => root.render(<SetupPage />));
  return { mock, sent, root };
}

async function main() {
  for (const scenario of GYRO_HEALTH_MOCK_SCENARIOS) {
    await test(`cards render mock scenario ${scenario} verbatim`, () => {
      const html = renderToStaticMarkup(<GyroHealthCards raw={statusRaw(mockGyroHealthLines(scenario))} />);
      assert.equal(staticValue(html, "gyro_health"), EXPECT[scenario][0]);
      assert.equal(staticValue(html, "gyro_sat_count"), EXPECT[scenario][1]);
      assert.ok(!html.includes("hidden"), "no hidden literal");
    });
  }
  await test("sat_count above 2^32 / 2^53 / 2^64 is shown digit for digit (no Number math)", () => {
    for (const v of ["4294967296", "9007199254740993", GYRO_HEALTH_MOCK_BIG_SAT, "123456789012345678901234567890"]) {
      const html = renderToStaticMarkup(<GyroHealthCards raw={statusRaw(["gyro_health: ok", `gyro_sat_count: ${v}`])} />);
      assert.equal(staticValue(html, "gyro_sat_count"), v);
    }
  });
  await test("malformed, empty, duplicated or absent values show unknown; no reading shows unknown", () => {
    for (const [lines, health, sat] of [
      [["gyro_health: ok", "gyro_sat_count: -1"], "ok", "unknown"],
      [["gyro_health: ok", "gyro_sat_count: 12abc"], "ok", "unknown"],
      [["gyro_health: ok", "gyro_sat_count: 007"], "ok", "unknown"],
      [["gyro_health: ok", "gyro_sat_count: 1e3"], "ok", "unknown"],
      [["gyro_health:", "gyro_sat_count:"], "unknown", "unknown"],
      [["gyro_health: ok", "gyro_health: stuck", "gyro_sat_count: 1"], "unknown", "1"],
      [["gyro_health: stuck"], "stuck", "unknown"],
      [["gyro_sat_count: 5"], "unknown", "5"],
    ] as [string[], string, string][]) {
      const html = renderToStaticMarkup(<GyroHealthCards raw={statusRaw(lines)} />);
      assert.equal(staticValue(html, "gyro_health"), health, JSON.stringify(lines));
      assert.equal(staticValue(html, "gyro_sat_count"), sat, JSON.stringify(lines));
    }
    const none = renderToStaticMarkup(<GyroHealthCards raw={null} />);
    assert.equal(staticValue(none, "gyro_health"), "unknown");
    assert.equal(staticValue(none, "gyro_sat_count"), "unknown");
  });
  await test("mock FW contract: any non-ok health prints gyro_ok no and the Arm gate blocks; ok/sat-big keep gyro_ok yes", async () => {
    for (const scenario of GYRO_HEALTH_MOCK_SCENARIOS) {
      const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, gyroHealthScenario: scenario });
      await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
      const st = parseStatus(await mock.sendCommand("status"));
      const healthy = scenario === "ok" || scenario === "sat-big" || scenario === "missing";
      assert.equal(st.gyro_ok, healthy ? "yes" : "no", scenario);
      assert.equal(shouldDisableArm(st), !healthy, scenario);
      assert.equal(await mock.sendCommand("arm"), healthy ? "armed" : "arm refused (gyro unhealthy or failsafe)", scenario);
      await mock.disconnect();
    }
  });
  await test("SetupPage: cards sit right after gyro_bind and show the live status values verbatim", async () => {
    const { mock, sent, root } = await rig("ok");
    assert.ok(await waitFor(() => card("gyro_health") === "ok", 2500), `gyro_health card: "${card("gyro_health")}" sent=${JSON.stringify(sent)}`);
    assert.equal(card("gyro_sat_count"), "0");
    const labels = cardLabels();
    const i = labels.indexOf("gyro_bind");
    assert.deepEqual(labels.slice(i - 1, i + 3), ["gyro_ok", "gyro_bind", "gyro_health", "gyro_sat_count"], JSON.stringify(labels));
    root.unmount(); await mock.disconnect();
  });
  await test("SetupPage: a fault appearing mid-session is shown on the next poll (re-read, not the first reply)", async () => {
    const { mock, sent, root } = await rig("ok");
    assert.ok(await waitFor(() => card("gyro_health") === "ok", 2500));
    const before = sent.filter((c) => c === "status").length;
    mock.setMockGates({ gyroHealthScenario: "stuck" });
    assert.ok(await waitFor(() => card("gyro_health") === "stuck", 2500), `after fault: "${card("gyro_health")}"`);
    assert.ok(sent.filter((c) => c === "status").length > before, "a new status read happened");
    assert.equal(card("gyro_sat_count"), "3");
    mock.setMockGates({ gyroHealthScenario: "unknown-token" });
    assert.ok(await waitFor(() => card("gyro_health") === GYRO_HEALTH_MOCK_FUTURE_TOKEN, 2500), `future token: "${card("gyro_health")}"`);
    mock.setMockGates({ gyroHealthScenario: "sat-big" });
    assert.ok(await waitFor(() => card("gyro_sat_count") === GYRO_HEALTH_MOCK_BIG_SAT, 2500), `big sat: "${card("gyro_sat_count")}"`);
    root.unmount(); await mock.disconnect();
  });
  await test("SetupPage: older FC (keys missing) shows unknown and says so; disconnected shows unknown", async () => {
    const { mock, root } = await rig("missing");
    assert.ok(await waitFor(() => container.textContent.includes("does not report gyro_health"), 2500),
      container.textContent.slice(0, 400));
    assert.equal(card("gyro_health"), "unknown");
    assert.equal(card("gyro_sat_count"), "unknown");
    root.unmount(); await mock.disconnect();
    const off = await rig("stuck", "disconnected");
    await sleep(300);
    assert.equal(card("gyro_health"), "unknown");
    assert.equal(card("gyro_sat_count"), "unknown");
    off.root.unmount(); await off.mock.disconnect();
  });
  console.log(`PASS Setup gyro sanity readout: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); }); // exit: a failed render test can leave pollers running
