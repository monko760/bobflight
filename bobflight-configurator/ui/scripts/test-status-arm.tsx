/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * N2: Status page Arm check. The firmware CLI `arm` never arms any more: it
 * runs the same gate as the radio ARM switch and replies `arm refused: <token>`.
 * Checks, against the real StatusPage in the fakeDom harness and the honest
 * MockBobFlightHost:
 *  - every token the Configurator knows is exactly the set the firmware prints
 *    (read from tasks.c / arming.c), each with an explanation;
 *  - the button sends `arm` only after confirmation and shows the FC reply
 *    verbatim plus the explanation; the mock never arms from `arm`;
 *  - while status blocks (gyro_ok no / failsafe ACTIVE / armed) the button is
 *    disabled and shows the same CLI text the FC sends for `arm`;
 *  - legacy (pre-N2) and unknown replies are shown verbatim, never rewritten.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { ARM_REFUSAL_TOKENS, ARM_REFUSAL_TEXT, parseArmReply } from "@bobflight/protocol";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { StatusPage } from "../src/pages/StatusPage";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { parseStatus, statusArmRefusal } from "../src/protocol/parseStatus";
import type { CliCommand } from "../src/protocol/types";

const { container } = installFakeDom();
const isEl = (n: unknown): n is FakeElement => !!n && (n as { nodeType?: number }).nodeType === 1;
function visibleText(n: FakeElement): string {
  if (n.hasAttribute("hidden")) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : (c as unknown as { textContent: string }).textContent)).join("");
}
const byTestId = (id: string) => container.findAll((e) => e.getAttribute("data-testid") === id)[0] ?? null;
const shown = (id: string) => { const e = byTestId(id); return e ? visibleText(e) : null; };
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function button(text: string): FakeElement {
  const b = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === text)[0];
  assert.ok(b, `button "${text}"`);
  return b;
}
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
function click(text: string) { const b = button(text); assert.ok(!isDisabled(b), `"${text}" enabled`); flushSync(() => reactProps(b).onClick({})); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); } catch (e) { console.log(`FAIL ${name}`); throw e; }
  passed++; console.log(`PASS ${name}`);
}

interface Rig { mock: MockBobFlightHost; sent: string[]; root: Root; ctx: Record<string, unknown>; render(): void }
async function rig(opts: { gyroHealthy: boolean; failsafeActive?: boolean; reply?: (cmd: string) => string | null }): Promise<Rig> {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: opts.gyroHealthy });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  if (opts.failsafeActive !== undefined) mock.setMockGates({ failsafeActive: opts.failsafeActive });
  const sent: string[] = [];
  const root: Root = createRoot(container as never);
  const r = {} as Rig;
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    sendCommand: async (cmd: CliCommand) => { sent.push(cmd); const o = opts.reply?.(cmd); return o ?? mock.sendCommand(cmd); },
  };
  const ctx: Record<string, unknown> = {
    host, connectionStatus: "connected", version: "BobFlight test", status: null,
    refreshStatus: async () => { ctx.status = parseStatus(await mock.sendCommand("status" as CliCommand)); r.render(); },
    setLastError: () => {},
  };
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  Object.assign(r, { mock, sent, root, ctx, render: () => flushSync(() => root.render(<StatusPage />)) });
  await (ctx.refreshStatus as () => Promise<void>)();
  return r;
}
async function armCheck(r: Rig): Promise<string> {
  const before = r.sent.length;
  click("Arm check…");
  assert.equal(r.sent.length, before, "nothing sent before confirmation");
  click("Send arm");
  assert.equal(shown("arm-check-line"), null, "previous reply cleared while the new check runs");
  assert.ok(await waitFor(() => shown("arm-check-line") !== null), "arm reply shown");
  assert.deepEqual(r.sent.slice(before).filter((c) => c === "arm"), ["arm"], "exactly one arm sent");
  return shown("arm-check-line")!;
}

async function main() {
  await test("token contract: the Configurator list is exactly the firmware's arm refusal tokens, each explained", () => {
    const fw = ["../../../bobflight-firmware/src/sched/tasks.c", "../../../bobflight-firmware/src/flight/arming.c"]
      .map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
    const body = (name: string) => { const i = fw.indexOf(`${name}(void)\n{`); assert.ok(i >= 0, name); return fw.slice(i, fw.indexOf("\n}\n", i)); };
    const fwTokens = new Set(["arm_cli_refusal", "arm_gate_block", "arming_block_reason"]
      .flatMap((f) => [...body(f).matchAll(/return "([a-z-]+)";/g)].map((m) => m[1])));
    assert.deepEqual([...fwTokens].sort(), [...ARM_REFUSAL_TOKENS].sort());
    for (const t of ARM_REFUSAL_TOKENS) assert.ok(ARM_REFUSAL_TEXT[t].length > 10, t);
    const cli = readFileSync(new URL("../../../bobflight-firmware/src/drivers/cli.c", import.meta.url), "utf8");
    assert.ok(cli.includes('cli_write_str("arm refused: ");\n        cli_write_str(arm_cli_refusal());'), "cli.c prints the prefix + gate token");
    assert.ok(!/cli_write_str\("armed\\r\\n"\)/.test(cli), "cli.c `arm` never prints armed");
  });
  await test("healthy FC: Arm check sends `arm` once after confirmation, shows the reply verbatim, never arms", async () => {
    const r = await rig({ gyroHealthy: true, failsafeActive: false });
    assert.equal(r.sent.includes("arm"), false, "never sent on render");
    assert.equal(statusArmRefusal(r.ctx.status as never), null);
    assert.equal(byTestId("arm-status-refusal"), null);
    assert.match(shown("arm-gate-note")!, /USB never arms: only the radio ARM switch arms/);
    assert.equal(await armCheck(r), "arm refused: arm-switch-required");
    assert.equal(shown("arm-check-explanation"), ARM_REFUSAL_TEXT["arm-switch-required"]);
    assert.equal((r.ctx.status as { arm: string }).arm, "disarmed", "status re-read: still disarmed");
    r.root.unmount(); await r.mock.disconnect();
  });
  await test("ARM switch already on: reply arm-switch-on; switching off then on arms; next check says already-armed", async () => {
    const r = await rig({ gyroHealthy: false, failsafeActive: false });
    assert.equal(r.mock.simulateArmSwitch(true), false, "switch on while gyro unhealthy: refused, switch stays on");
    r.mock.setMockGates({ gyroHealthy: true }); await (r.ctx.refreshStatus as () => Promise<void>)();
    assert.equal(await armCheck(r), "arm refused: arm-switch-on");
    assert.equal(shown("arm-check-explanation"), ARM_REFUSAL_TEXT["arm-switch-on"]);
    assert.equal(r.mock.simulateArmSwitch(true), false, "still on: no new edge, no arm");
    assert.equal(r.mock.simulateArmSwitch(false), false);
    assert.equal(r.mock.simulateArmSwitch(true), true, "fresh off-to-on edge arms");
    await (r.ctx.refreshStatus as () => Promise<void>)();
    assert.ok(isDisabled(button("Arm check…")), "armed: Arm check disabled");
    assert.equal(shown("arm-status-refusal")?.startsWith("Arm check now: arm refused: already-armed"), true);
    assert.equal(String(await r.mock.sendCommand("arm" as CliCommand)), "arm refused: already-armed", "same text as the FC");
    r.root.unmount(); await r.mock.disconnect();
  });
  for (const [label, gyro, fs, token] of [["gyro_ok no", false, false, "gyro-unhealthy"], ["failsafe ACTIVE", true, true, "failsafe"], ["both", false, true, "gyro-unhealthy"]] as const) {
    await test(`status blocks (${label}): disabled, showing the exact CLI reply the FC gives`, async () => {
      const r = await rig({ gyroHealthy: gyro, failsafeActive: fs });
      const b = button("Arm check…");
      assert.ok(isDisabled(b));
      assert.equal(b.getAttribute("title"), `Disabled: the flight controller replies "arm refused: ${token}"`);
      assert.equal(shown("arm-status-refusal"), `Arm check now: arm refused: ${token} — ${ARM_REFUSAL_TEXT[token]}`);
      const alert = container.findAll((e) => e.getAttribute("role") === "alert").map(visibleText).join(" ");
      assert.match(alert, new RegExp(`the\\s+flight controller replies arm refused: ${token}`));
      assert.equal(String(await r.mock.sendCommand("arm" as CliCommand)), `arm refused: ${token}`, "mock FC sends the same text");
      assert.equal(r.sent.includes("arm"), false, "page never sent arm");
      r.root.unmount(); await r.mock.disconnect();
    });
  }
  await test("pre-N2 firmware `armed` and unknown tokens: shown verbatim, never rewritten", async () => {
    let next = "armed";
    const r = await rig({ gyroHealthy: true, failsafeActive: false, reply: (c) => (c === "arm" ? next + "\r\n" : null) });
    assert.equal(await armCheck(r), "armed");
    assert.match(shown("arm-check-explanation")!, /Firmware before N2/);
    assert.equal(byTestId("arm-check-reply")!.getAttribute("class"), "fail");
    next = "arm refused: rf-jammed";
    assert.equal(await armCheck(r), "arm refused: rf-jammed");
    assert.equal(byTestId("arm-check-explanation"), null, "unknown token: no invented explanation");
    next = "arm refused (gyro unhealthy or failsafe)";
    assert.equal(await armCheck(r), "arm refused (gyro unhealthy or failsafe)");
    assert.equal(parseArmReply(next).kind, "legacy-refused");
    r.root.unmount(); await r.mock.disconnect();
  });
  console.log(`PASS status page arm check: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); });
