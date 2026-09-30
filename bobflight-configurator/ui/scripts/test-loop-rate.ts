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
import { loopRateSettingView, parseLoopRateReport, LOOP_RATE_OPTIONS, loopRateUnsupportedLine, LOOP_RATE_ARMED_LINE, loopRateReasonView, LOOP_RATE_REASON_TEXT } from "../../protocol/src/loop-rate-setting";
import { readLoopRateSetting, selectLoopRate, saveLoopRate, LoopTargetWatcher, LOOP_RATE_SETTING_EMPTY, LOOP_RATE_SAVED_MESSAGE, LOOP_RATE_SET_MESSAGE, type LoopRateSettingHost } from "../src/setup/loopRateSetting";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoopRateReasonCard } from "../src/setup/LoopRateReasonCard";
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
  await test("UI MockBobFlightHost scenarios 1000/1, 8000/2, 8000/1, 8000/1-guard, 1000/1-no8k, unavailable, missing (older FC)", async () => {
    const expected: Record<LoopRateMockScenario, string[]> = {
      "missing": ["unknown", "unknown", "unknown"], "1000/1": ["1000", "999", "1"],
      "8000/2": ["4000", "3998", "9007199254740993"], "unavailable": ["4000", "unknown", "0"],
      "8000/1": ["8000", "7996", "4"], "8000/1-guard": ["4000", "4000", "16384"],
      "1000/1-no8k": ["1000", "1000", "0"],
      "bidir-4k": ["4000", "3999", "2"], "bidir-8k-capped": ["4000", "3997", "3"], "bidir-capture-failed": ["1000", "1000", "0"],
      "bidir-older-fc": ["1000", "1000", "0"], "reason-missing": ["4000", "3999", "2"],
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
    assert.equal((setup.match(/await pauseLoopPoll\(\);/g) ?? []).length, 3, "Refresh, Restore defaults and every loop-rate selector action pause the poll first");
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
  await test("loop-rate selector actions over the UI mock host: read, set (pending until reboot), honest save, reboot applies", async () => {
    const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "8000/2" });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    let state = await readLoopRateSetting(host);
    assert.deepEqual(state.get, { kind: "value", value: "4000" });
    let view = loopRateSettingView(state.get, state.report, parseLoopStatus(await host.sendCommand("status")).targetHz);
    assert.equal(view.display, "4 kHz"); assert.equal(view.pendingReboot, false); assert.equal(view.supported, true);
    assert.ok(view.notices.some(n => /takes effect after Save \+ reboot/.test(n)), "reboot needed is stated when the FC reports the setting");
    state = await selectLoopRate(host, state, "8000");
    assert.equal(state.message, LOOP_RATE_SET_MESSAGE); assert.equal(state.error, "");
    view = loopRateSettingView(state.get, state.report, "4000");
    assert.equal(view.display, "8 kHz"); assert.equal(view.pendingReboot, true);
    assert.ok(view.notices.some(n => /^Pending: 8 kHz is selected/.test(n)));
    assert.equal(parseLoopStatus(await host.sendCommand("status")).targetHz, "4000", "running rate unchanged until reboot");
    // Demo host has no controller flash: the existing save flow refuses honestly and keeps the reading.
    const refused = await saveLoopRate(host, state);
    assert.match(refused.error, /not stored on a controller/); assert.deepEqual(refused.get, state.get);
    // N6: a reboot applies only saved values; the unsaved RAM change is dropped.
    await host.sendCommand("reboot"); await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const unsaved = await readLoopRateSetting(host);
    assert.deepEqual(unsaved.get, { kind: "value", value: "4000" }, "unsaved change lost on reboot");
    assert.equal(unsaved.report?.bootSettingHz, "4000"); assert.equal(unsaved.report?.pendingReboot, false);
    assert.equal(parseLoopStatus(await host.sendCommand("status")).targetHz, "4000", "unsaved change never applied");
    state = await selectLoopRate(host, unsaved, "8000"); assert.equal(state.error, "");
    // A verified-save host (stub around the same mock) reports saved + reboot needed.
    const saves: string[] = [];
    const flashHost: LoopRateSettingHost = { sendCommand: c => host.sendCommand(c), saveSettings: async () => { saves.push("save"); host.simulateVerifiedSave(); } };
    const saved = await saveLoopRate(flashHost, state);
    assert.equal(saves.length, 1); assert.equal(saved.message, LOOP_RATE_SAVED_MESSAGE); assert.equal(saved.report?.pendingReboot, true);
    assert.equal(loopRateSettingView(saved.get, saved.report, "4000").bootDisplay, "4 kHz", "applied at boot unchanged until reboot");
    await host.sendCommand("reboot"); await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const booted = await readLoopRateSetting(host);
    assert.equal(booted.report?.bootSettingHz, "8000"); assert.equal(booted.report?.pendingReboot, false);
    assert.equal(parseLoopStatus(await host.sendCommand("status")).targetHz, "8000", "rate applied after reboot");
    await host.restoreDefaults();
    assert.deepEqual((await readLoopRateSetting(host)).get, { kind: "value", value: "4000" }, "FW defaults reset the setting");
    await host.disconnect();
  });
  await test("older FC shows unknown and is never written; guard fallback is reported with the applied target", async () => {
    const old = new MockBobFlightHost({ connectDelayMs: 0 });
    await old.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const sent: string[] = [];
    const spy: LoopRateSettingHost = { sendCommand: c => { sent.push(c); return old.sendCommand(c); }, saveSettings: async () => {} };
    const st = await readLoopRateSetting(spy);
    assert.deepEqual(st.get, { kind: "unsupported" }); assert.equal(st.report, null);
    assert.deepEqual(sent, ["get loop_rate_hz"], "no loop_rate report asked of an older FC");
    const v = loopRateSettingView(st.get, st.report, null);
    assert.equal(v.display, "unknown"); assert.equal(v.supported, false); assert.equal(v.selected, null);
    assert.ok(!v.notices.some(n => /takes effect/.test(n)), "N1: no Save + reboot note for an FC without the setting");
    assert.equal(v.bootDisplay, "unknown");
    const refused = await selectLoopRate(spy, st, "8000");
    assert.match(refused.error, /not available/); assert.deepEqual(sent, ["get loop_rate_hz"], "never sends set to an older FC");
    await old.disconnect();
    const guard = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "8000/1-guard" });
    await guard.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const g = await readLoopRateSetting(guard);
    const gv = loopRateSettingView(g.get, g.report, parseLoopStatus(await guard.sendCommand("status")).targetHz);
    assert.equal(gv.display, "8 kHz");
    assert.ok(gv.notices.some(n => /running 4000 Hz instead of its boot setting 8000 Hz \(overrun-guard\)/.test(n)), gv.notices.join(" | "));
    assert.equal(parseLoopRateReport(await guard.sendCommand("loop_rate"))?.active, "8000/2");
    await guard.disconnect();
    assert.deepEqual(LOOP_RATE_SETTING_EMPTY, { get: null, report: null, message: "", error: "" });
  });
  await test("BLOCKER: refused set 8000 on a board without the 8 kHz path keeps the value, shows the exact FW line, re-reads via get", async () => {
    const FW_LINE = "set failed: loop_rate_hz 8000 not supported on tmotor_f7_v2 (no 8 kHz gyro path)"; // drivers/cli.c, verbatim
    assert.equal(loopRateUnsupportedLine("8000", "tmotor_f7_v2"), FW_LINE);
    const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "1000/1-no8k" });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const sent: string[] = [];
    const spy: LoopRateSettingHost = { sendCommand: c => { sent.push(c); return host.sendCommand(c); }, saveSettings: async () => {} };
    const before = await readLoopRateSetting(spy);
    assert.deepEqual(before.get, { kind: "value", value: "1000" });
    sent.length = 0;
    // Stale caller state: the result must come from a fresh read, not from `current`.
    const after = await selectLoopRate(spy, { ...before, report: null, message: "stale message" }, "8000");
    assert.deepEqual(after.get, { kind: "value", value: "1000" }, "get.value stays at the previous value (no optimistic set)");
    assert.equal(after.error, FW_LINE, "error is exactly the FW refusal line (not swallowed or rewritten)");
    assert.equal(after.message, "", "no success message on a refusal");
    assert.deepEqual(sent, ["set loop_rate_hz 8000", "get loop_rate_hz", "loop_rate"], "set, then re-read via get (and the report)");
    assert.equal(after.report?.bootSettingHz, "1000", "report refreshed by the re-read"); assert.equal(after.report?.pendingReboot, false);
    const view = loopRateSettingView(after.get, after.report, parseLoopStatus(await host.sendCommand("status")).targetHz);
    assert.equal(view.display, "1 kHz"); assert.equal(view.pendingReboot, false); assert.ok(!view.notices.some(n => /^Pending/.test(n)));
    const four = await selectLoopRate(spy, after, "4000");
    assert.equal(four.error, loopRateUnsupportedLine("4000", "tmotor_f7_v2")); assert.deepEqual(four.get, { kind: "value", value: "1000" });
    await host.disconnect();
  });
  await test("armed refusal: get.value unchanged, error is the verbatim FW line, message empty, re-read after set", async () => {
    const host = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, loopRateScenario: "8000/2" });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const sent: string[] = [];
    const spy: LoopRateSettingHost = { sendCommand: c => { sent.push(c); return host.sendCommand(c); }, saveSettings: async () => {} };
    const before = await readLoopRateSetting(spy);
    assert.deepEqual(before.get, { kind: "value", value: "4000" });
    assert.equal(await host.sendCommand("arm"), "armed");
    sent.length = 0;
    const after = await selectLoopRate(spy, { ...before, message: "stale message" }, "8000");
    assert.deepEqual(after.get, { kind: "value", value: "4000" });
    assert.equal(after.error, LOOP_RATE_ARMED_LINE); assert.equal(after.error, "set failed: armed", "N3: shown verbatim");
    assert.equal(after.message, "");
    assert.deepEqual(sent, ["set loop_rate_hz 8000", "get loop_rate_hz", "loop_rate"]);
    assert.equal(after.report?.pendingReboot, false);
    await host.sendCommand("disarm"); await host.disconnect();
  });
  await test("selector wiring: options from protocol, existing save flow, unknown for older FC, reboot notice, allowlist", () => {
    const setup = code(source("../src/pages/SetupPage.tsx"));
    const ctl = code(source("../src/setup/loopRateSetting.ts"));
    assert.match(setup, /LOOP_RATE_OPTIONS\.map\(/, "selector options come from protocol LOOP_RATE_OPTIONS");
    assert.match(setup, /isLoopRateOption\(value\)/);
    assert.match(setup, /loopRateSettingView\(loopSetting\.get, loopSetting\.report, loopTarget\)/);
    assert.match(setup, /const loopTarget = loopPoll\.raw === null \? null : parseLoopStatus\(loopPoll\.raw\)\.targetHz;/, "applied rate only from status loop_target_hz");
    assert.match(setup, /loopSelector\.supported === true/, "selector disabled unless the FC reports the setting");
    assert.match(setup, /LOOP_RATE_SETTING_UNKNOWN/);
    assert.match(setup, /loopSelector\.notices\.map/);
    // N2: RAM selection and the FW boot setting are separate rows.
    assert.match(setup, /<div className="k">Selected \(controller RAM\)<\/div>\s*<div className="v">\{connected \? loopSelector\.display : LOOP_RATE_SETTING_UNKNOWN\}<\/div>/);
    assert.match(setup, /<div className="k">Applied at boot<\/div>\s*<div className="v">\{connected \? loopSelector\.bootDisplay : LOOP_RATE_SETTING_UNKNOWN\}<\/div>/);
    assert.match(source("../../protocol/src/loop-rate-setting.ts"), /const boot = report\?\.bootSettingHz \?\? null;/, "boot row sourced from loop_rate_boot_setting_hz");
    assert.match(source("../src/pages/SetupPage.tsx"), /^\/\* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2\.0 \*\//, "N8: SPDX header");
    for (const action of ["selectLoopRate(host, loopSetting, value)", "saveLoopRate(host, loopSetting)", "readLoopRateSetting(host)"])
      assert.ok(setup.includes(`runLoopRateAction(() => ${action})`), action);
    const run = setup.slice(setup.indexOf("async function runLoopRateAction"), setup.indexOf("useEffect(", setup.indexOf("async function runLoopRateAction")));
    assert.match(run, /setBusy\(true\);[\s\S]*await pauseLoopPoll\(\);[\s\S]*setBusy\(false\)/, "selector actions pause the poll and hold busy");
    assert.match(ctl, /await host\.saveSettings\(\)/, "persists through the existing verified save flow");
    assert.doesNotMatch(ctl, /sendCommand\("save"\)|sendRaw/, "no ad-hoc save");
    assert.doesNotMatch(ctl, /\b(1000|2000|4000|8000)\b/, "controller has no hardcoded rates");
    assert.match(setup, /setLoopSettingRead\(false\); \/\/ FW `defaults` also resets loop_rate_hz/);
    for (const cmd of ["get loop_rate_hz", "loop_rate", ...LOOP_RATE_OPTIONS.map(v => `set loop_rate_hz ${v}`)]) assert.equal(parseCliInput(cmd), cmd, cmd);
    for (const bad of ["set loop_rate_hz 2000", "set loop_rate_hz 4000.0", "set loop_rate_hz"]) assert.equal(parseCliInput(bad), null, bad);
  });
  await test("B2 reason card over the UI mock host: FC token as sent, re-read after every set (no optimistic UI)", async () => {
    const want: Partial<Record<LoopRateMockScenario, string>> = {
      "bidir-4k": "setting", "bidir-8k-capped": "dshot-bidir-reply-window", "bidir-capture-failed": "dshot-bidir-capture-failed",
      "bidir-older-fc": "dshot-bidir-polled-listen", "reason-missing": "unknown", "8000/2": "setting", "8000/1-guard": "overrun-guard",
    };
    for (const [scenario, token] of Object.entries(want) as [LoopRateMockScenario, string][]) {
      const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: scenario });
      await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
      const st = await readLoopRateSetting(host);
      const reason = loopRateReasonView(st.report);
      assert.equal(reason.token, token, scenario);
      const forces = /forces a 1 kHz/.test(reason.explanation ?? "");
      assert.equal(forces, token === "dshot-bidir-polled-listen", `${scenario}: "forces 1 kHz" copy only for the FC's polled-listen token`);
      assert.equal(/dshot_bidir=on/.test(await host.sendCommand("get dshot_bidir")), scenario.startsWith("bidir-"), `${scenario}: bidir fixture`);
      await host.disconnect();
    }
    // Bidir on with a "setting" reason never shows fallback text; the reason is not inferred from bidir.
    const kept = loopRateReasonView(parseLoopRateReport(["loop_rate_api: 1", "loop_rate_reason: setting", "loop_rate_end: 1"].join("\r\n")));
    assert.equal(kept.fallback, false); assert.doesNotMatch(kept.explanation ?? "", /bidir|1 kHz/i);
    // Every selector action re-reads get + loop_rate from the FC after the set.
    const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "bidir-8k-capped" });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const sent: string[] = [];
    const spy: LoopRateSettingHost = { sendCommand: c => { sent.push(c); return host.sendCommand(c); }, saveSettings: async () => { sent.push("<save>"); } };
    let st = await readLoopRateSetting(spy);
    assert.equal(loopRateReasonView(st.report).token, "dshot-bidir-reply-window");
    sent.length = 0; st = await selectLoopRate(spy, st, "4000");
    assert.deepEqual(sent, ["set loop_rate_hz 4000", "get loop_rate_hz", "loop_rate"], "set is always followed by get + loop_rate");
    assert.deepEqual(st.get, { kind: "value", value: "4000" }); assert.equal(st.report?.settingHz, "4000", "value from the FC re-read");
    assert.equal(loopRateReasonView(st.report).token, "dshot-bidir-reply-window", "reason stays what the FC reports until reboot");
    sent.length = 0; st = await saveLoopRate(spy, st);
    assert.deepEqual(sent, ["<save>", "get loop_rate_hz", "loop_rate"], "save is followed by a re-read");
    await host.sendCommand("reboot"); await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    st = await readLoopRateSetting(host);
    assert.equal(loopRateReasonView(st.report).token, "setting", "bidir is RAM-only: after reboot the FC reports its own reason");
    assert.match(await host.sendCommand("get dshot_bidir"), /dshot_bidir=off/);
    await host.disconnect();
  });
  await test("reason card wiring: renders loopSetting.report through loopRateReasonView; no inference, no rates, no StoragePanel", () => {
    const setup = code(source("../src/pages/SetupPage.tsx"));
    const card = code(source("../src/setup/LoopRateReasonCard.tsx"));
    assert.match(setup, /<LoopRateReasonCard report=\{loopSetting\.report\} connected=\{connected\} \/>/);
    assert.match(card, /loopRateReasonView\(connected \? report : null\)/);
    assert.doesNotMatch(card, /\b(1000|2000|4000|8000)\b|kHz/, "card has no rate text of its own");
    assert.doesNotMatch(card, /bidir|dshot|polled/i, "card never infers a reason from DShot state");
    assert.doesNotMatch(card, /StoragePanel|blocked=|sendCommand|setStatus/, "display only");
    assert.doesNotMatch(setup, /polled-listen|forces a 1 kHz/, "no hardcoded bidir copy in Setup");
    const motors = code(source("../src/pages/MotorsPage.tsx"));
    assert.doesNotMatch(motors, /forces? (a )?1 kHz|1 kHz loop|polled/i, "Motors no longer implies bidir = 1 kHz");
    assert.match(motors, /loop-rate reason exactly as reported/);
    assert.equal(Object.keys(LOOP_RATE_REASON_TEXT).filter(k => /1 kHz loop/.test(LOOP_RATE_REASON_TEXT[k])).join(), "dshot-bidir-polled-listen");
  });
  await test("B1: a refused set is never applied optimistically: set, then get + loop_rate; previous value kept; FW refusal verbatim", async () => {
    // Replies recorded from the tmotor_f7_v2 host firmware (drivers/cli.c
    // "set failed: loop_rate_hz %lu not supported on %s (no 8 kHz gyro path)").
    const FW_REFUSAL = "set failed: loop_rate_hz 8000 not supported on tmotor_f7_v2 (no 8 kHz gyro path)";
    const REPORT = ["loop_rate_api: 1", "loop_rate_setting_hz: 1000", "loop_rate_boot_setting_hz: 1000", "loop_rate_pending_reboot: 0",
      "loop_rate_profile: 1000/1", "loop_rate_active: 1000/1", "loop_rate_reason: setting", "loop_rate_guard_level: 0",
      "loop_rate_gyro_odr_hz: 0", "loop_rate_gyro_spi_hz: 0", "loop_rate_end: 1"].join("\r\n") + "\r\n";
    const sent: string[] = [];
    const spy: LoopRateSettingHost = {
      sendCommand: async c => {
        sent.push(c);
        if (c === "get loop_rate_hz") return "loop_rate_hz=1000\r\n";
        if (c === "set loop_rate_hz 8000") return `${FW_REFUSAL}\r\n`;
        if (c === "loop_rate") return REPORT;
        throw new Error(`unexpected command ${c}`);
      },
      saveSettings: async () => { sent.push("<save>"); },
    };
    const before = await readLoopRateSetting(spy);
    assert.deepEqual(before.get, { kind: "value", value: "1000" });
    sent.length = 0;
    const after = await selectLoopRate(spy, before, "8000");
    assert.deepEqual(sent, ["set loop_rate_hz 8000", "get loop_rate_hz", "loop_rate"], "set, then get, then loop_rate");
    assert.deepEqual(after.get, { kind: "value", value: "1000" }, "get still returns the previous value");
    assert.equal(after.report?.settingHz, "1000"); assert.equal(after.report?.pendingReboot, false);
    assert.equal(after.error, FW_REFUSAL, "error is the FW line verbatim");
    assert.equal(after.message, "", "no success message for a refused set");
    const view = loopRateSettingView(after.get, after.report, "1000");
    assert.equal(view.selected, "1000"); assert.equal(view.display, "1 kHz"); assert.equal(view.pendingReboot, false);
    assert.ok(!view.notices.some(n => /Pending/.test(n)), "a refused set is never shown as pending");
  });
  await test("S1: LoopRateReasonCard markup: the <code> text is exactly the FC token, or unknown", () => {
    const report = (reason: string | null) => parseLoopRateReport(["loop_rate_api: 1", "loop_rate_setting_hz: 4000", "loop_rate_active: 8000/2",
      ...(reason === null ? [] : [`loop_rate_reason: ${reason}`]), "loop_rate_end: 1"].join("\r\n"));
    const render = (r: ReturnType<typeof report>, connected = true) =>
      renderToStaticMarkup(createElement(LoopRateReasonCard, { report: r, connected })).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    const codes = (html: string) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(m => m[1]);
    const setting = render(report("setting"));
    assert.deepEqual(codes(setting), ["setting"]);
    assert.ok(setting.includes(LOOP_RATE_REASON_TEXT["setting"]));
    const future = render(report("some-future-reason"));
    assert.deepEqual(codes(future), ["some-future-reason"], "an unrecognised token is shown verbatim");
    assert.match(future, /no description for this reason; it is shown as the controller sent it/);
    assert.doesNotMatch(future, /No valid loop-rate reason/);
    const missing = render(report(null));
    assert.deepEqual(codes(missing), ["unknown"], "a missing reason is unknown");
    assert.ok(missing.includes("<p class=\"muted\">No valid loop-rate reason in the controller's report: unknown.</p>"), missing);
    assert.deepEqual(codes(render(report("Bad_Token!"))), ["unknown"], "a malformed reason is unknown");
    assert.deepEqual(codes(render(null)), ["unknown"], "no report (older FC) is unknown");
    assert.deepEqual(codes(render(report("dshot-bidir-reply-window"), false)), ["unknown"], "disconnected is unknown");
    const capped = render(report("dshot-bidir-reply-window"));
    assert.deepEqual(codes(capped), ["dshot-bidir-reply-window"]);
    assert.ok(capped.includes("Bidirectional DShot is on: the eRPM reply does not fit an 8 kHz loop period, so the firmware lowers the loop below 8 kHz; the applied rate is the Loop target above."));
    assert.doesNotMatch(capped, /4 kHz/, "no hardcoded applied rate");
  });
  await test("N2: a change of the polled loop target re-reads the report, so a runtime fallback never shows a stale reason", async () => {
    const w = new LoopTargetWatcher();
    assert.equal(w.changed(null), false); assert.equal(w.changed("4000"), false, "first target only primes");
    assert.equal(w.changed("4000"), false); assert.equal(w.changed(null), false, "unknown target ignored");
    assert.equal(w.changed("1000"), true, "target changed"); assert.equal(w.changed("1000"), false);
    w.reset(); assert.equal(w.changed("4000"), false, "reset (disconnect) primes again");
    // Runtime fallback on the mock FC: bidir capture failure drops 8000/2 -> 1000/1.
    const host = new MockBobFlightHost({ connectDelayMs: 0, loopRateScenario: "bidir-4k" });
    await host.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
    const watch = new LoopTargetWatcher();
    let st = await readLoopRateSetting(host);
    assert.equal(loopRateReasonView(st.report).token, "setting");
    assert.equal(watch.changed(parseLoopStatus(await host.sendCommand("status")).targetHz), false);
    host.setMockGates({ loopRateScenario: "bidir-capture-failed" });
    const target = parseLoopStatus(await host.sendCommand("status")).targetHz;
    assert.equal(target, "1000");
    assert.equal(loopRateReasonView(st.report).token, "setting", "without a re-read the token would be stale");
    assert.equal(watch.changed(target), true, "new target triggers a re-read");
    st = await readLoopRateSetting(host);
    assert.equal(loopRateReasonView(st.report).token, "dshot-bidir-capture-failed", "reason refreshed with the new target");
    await host.disconnect();
    // Setup wiring: every polled target goes through the watcher; a change re-arms the existing read effect.
    const setup = code(source("../src/pages/SetupPage.tsx"));
    assert.match(setup, /const loopTargetWatcher = useMemo\(\(\) => new LoopTargetWatcher\(\), \[\]\);/);
    assert.match(setup, /if \(loopTargetWatcher\.changed\(loopTarget\)\) setLoopSettingRead\(false\);/);
    assert.match(setup, /loopTargetWatcher\.reset\(\);/);
    assert.match(setup, /\}, \[loopTargetWatcher, connected, loopTarget, busy, postFlashGate\]\);/);
    assert.match(setup, /if \(!loopSettingRead && !busy && !postFlashGate\) void runLoopRateAction\(\(\) => readLoopRateSetting\(host\)\);/);
  });
  await test("CI runs the loop-rate tests and the firmware contract", () => {
    const ci = source("../../../.github/workflows/ci.yml");
    for (const step of ["npm --prefix protocol run test:loop-rate", "npm --prefix ui run test:loop-rate", "npm --prefix ui run test:setup-poll", "node ../.github/scripts/loop-status-contract.cjs", "npm --prefix ui run test:storage"])
      assert.ok(ci.includes(step), step);
    assert.ok(ci.includes("cmake --build ../bobflight-firmware/build-contract-tmotor --target bobflight_host"), "CI builds the tmotor_f7_v2 host for the no-8k mock contract");
    assert.match(source("../package.json"), /"test:setup-poll": "node scripts\/run-setup-loop-poll\.mjs"/, "SetupPage render test (QA #57 poll kick) runs in CI");
    const pkg = source("../../protocol/package.json");
    assert.match(pkg, /"test:loop-rate": "tsc && node tests\/loop-rate\.cjs && node tests\/loop-rate-setting\.cjs"/, "protocol setting tests run in CI via test:loop-rate");
  });
  console.log(`PASS setup loop-rate UI: ${passed} tests`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
