/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * Board auto-detect (PR B): real CommandGate harness around the real MockBobFlightHost,
 * the six mock scenarios, and FlasherPage rendered into fakeDom (no source regex).
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FlasherPage } from "../src/pages/FlasherPage";
import { CommandGate } from "../src/protocol/commandGate";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { readBoardIdentity, identityView, identityGate } from "../src/flasher/boardIdentity";
import { BOARD_OPTIONS } from "../src/flasher/types";
import { RPM_GATE_ATTEMPTS, RPM_GATE_DELAY_MS } from "../src/filters/rpmFilter";
import { BOARD_ID_MOCK_SCENARIOS, parseBoardIdentity, type BoardIdMockScenario } from "@bobflight/protocol";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(10); } return pred(); }
const kakute = BOARD_OPTIONS.find((b) => b.boardId === "kakute_f7_hdv")!;
const matek = BOARD_OPTIONS.find((b) => b.boardId === "matek_f722_px")!;

/** A real gate in front of the real mock host, as createHost wires it. */
async function gatedMock(scenario: BoardIdMockScenario | undefined) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, boardIdScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const gate = new CommandGate(() => 1);
  let sends = 0;
  const host = { sendCommand: (c: "version") => gate.run(() => { sends++; return mock.sendCommand(c); }) };
  return { host, gate, sends: () => sends };
}

// ---------- 1. parser: allowed characters, verbatim, missing ----------
{
  const id = parseBoardIdentity("BobFlight x\r\nboard_id: kakute_f7_hdv\r\nboard_target: stm32f745\r\nboard_mcu: stm32f745\r\n");
  assert.deepEqual(id.board_id, { kind: "value", token: "kakute_f7_hdv" });
  for (const bad of ["Kakute", "kakute f7", "kakute.f7", "kakute/f7", "kakute_f7!", "", "ka\u00efkute", "kakute\t"]) {
    assert.equal(parseBoardIdentity(`board_id: ${bad}\r\n`).board_id.kind, "malformed", bad);
  }
  for (const ok of ["a", "0-9_z", "custom_f405xg_usb"]) assert.equal(parseBoardIdentity(`board_id: ${ok}\n`).board_id.kind, "value", ok);
  assert.equal(parseBoardIdentity("BobFlight 0.2.0\r\n").board_id.kind, "missing");
  console.log("PASS parser: only [a-z0-9_-] tokens trusted; others malformed; missing key is missing");
}

// ---------- 2. six scenarios through the real gate ----------
const expectations: Record<BoardIdMockScenario, (v: ReturnType<typeof identityView>) => void> = {
  "old-firmware": (v) => {
    assert.equal(v.boardId, "unknown"); assert.equal(v.mcu, "unknown"); assert.equal(v.preselect, null);
    assert.match(v.note!, /older firmware/);
    const g = identityGate(v, kakute, "F745", false); assert.equal(g.needsConfirm, true); assert.equal(g.blocked, true, "missing key is never a match");
    assert.equal(identityGate(v, kakute, "F745", true).blocked, false);
    assert.equal(identityGate(v, kakute, "F722", true).blocked, false, "no FC MCU: the existing HEX/board MCU gate applies elsewhere");
  },
  match: (v) => {
    assert.equal(v.boardId, "kakute_f7_hdv"); assert.equal(v.target, "stm32f745"); assert.equal(v.mcu, "stm32f745"); assert.equal(v.preselect, "kakute_f7_hdv");
    const g = identityGate(v, kakute, "F745", false); assert.equal(g.blocked, false); assert.equal(g.needsConfirm, false);
    assert.equal(identityGate(v, kakute, "F722", true).blocked, true, "HEX MCU mismatch always blocks");
  },
  "unknown-id": (v) => {
    assert.equal(v.boardId, "acme_f7_prototype", "verbatim"); assert.equal(v.preselect, null); assert.match(v.note!, /not in this Configurator's catalog/);
    // A valid board_id that no catalog board equals is a board_id mismatch for every selection:
    // blocked, and a manual confirm cannot override it.
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true); assert.equal(g.needsConfirm, false);
    assert(g.reasons.some((r) => r.startsWith("Board mismatch")));
    assert(identityGate(v, matek, "F722", true).reasons.some((r) => r.startsWith("MCU mismatch")), "board_mcu still gates");
  },
  "board-mismatch": (v) => {
    assert.equal(v.boardId, "matek_f722_px"); assert.equal(v.preselect, "matek_f722_px");
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true); assert.equal(g.needsConfirm, false);
    assert(g.reasons.some((r) => r.startsWith("Board mismatch")));
    assert.equal(identityGate(v, matek, "F722", false).blocked, false);
  },
  "mcu-mismatch": (v) => {
    assert.equal(v.boardId, "kakute_f7_hdv"); assert.equal(v.mcu, "stm32f722");
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true, "MCU mismatch blocks whatever the board_id");
    assert(g.reasons.some((r) => r.startsWith("MCU mismatch")));
    assert.equal(identityGate(v, matek, "F722", true).blocked, true, "and a board_id mismatch also blocks");
  },
  malformed: (v) => {
    assert.equal(v.boardId, "unknown (Kakute F7 HDV!)"); assert.equal(v.mcu, "unknown (STM32F745)"); assert.equal(v.target, "stm32f745");
    assert.equal(v.fcBoardId, null); assert.equal(v.fcMcu, null); assert.equal(v.preselect, null);
    assert.match(v.note!, /not trusted/);
    assert.equal(identityGate(v, kakute, "F745", false).blocked, true); assert.equal(identityGate(v, kakute, "F745", true).blocked, false);
  },
};
for (const s of BOARD_ID_MOCK_SCENARIOS) {
  const { host } = await gatedMock(s);
  const r = await readBoardIdentity(host);
  assert.equal(r.kind, "read", s);
  expectations[s](identityView(r));
}
console.log("PASS six mocks through the real gate: old firmware, match, unknown id, board mismatch, MCU mismatch, malformed");

// ---------- 3. busy gate: bounded retry, then unknown (never "older firmware") ----------
{
  assert.equal(RPM_GATE_ATTEMPTS, 30); assert.equal(RPM_GATE_DELAY_MS, 100);
  const { host, gate, sends } = await gatedMock("match");
  let release!: () => void; const held = gate.run(() => new Promise<void>((r) => { release = r; }));
  const t0 = Date.now(); const r = await readBoardIdentity(host); const took = Date.now() - t0;
  assert.equal(r.kind, "busy"); assert.equal(sends(), 0, "nothing reached the FC while busy");
  assert(took >= (RPM_GATE_ATTEMPTS - 1) * RPM_GATE_DELAY_MS - 50, `bounded retry budget used (${took} ms)`);
  const v = identityView(r);
  assert.equal(v.boardId, "unknown"); assert.doesNotMatch(v.note!, /older firmware/); assert.equal(v.preselect, null);
  release(); await held;
  // Busy for a while, then free: the retry reads the real reply.
  let release2!: () => void; const held2 = gate.run(() => new Promise<void>((r2) => { release2 = r2; }));
  setTimeout(() => release2(), 450);
  const r2 = await readBoardIdentity(host); await held2;
  assert.equal(r2.kind, "read"); assert.equal(identityView(r2).preselect, "kakute_f7_hdv");
  console.log(`PASS busy gate: ${RPM_GATE_ATTEMPTS} x ${RPM_GATE_DELAY_MS} ms then unknown (not older firmware); retry succeeds once free`);
}

// ---------- 4. FlasherPage in fakeDom ----------
const { container } = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { usb: new EventTarget() } });
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
const text = (n: FakeElement): string => n.childNodes.map((c) => (isEl(c) ? text(c) : c.textContent)).join("");
const byId = (tag: string, id: string) => container.findAll((e) => e.tagName === tag && e.getAttribute("id") === id)[0];
const props = (e: FakeElement) => (e as any)[Object.keys(e).find((k) => k.startsWith("__reactProps$"))!];
async function check(el: FakeElement, v: boolean) { flushSync(() => props(el).onChange({ target: { checked: v }, currentTarget: { checked: v } })); await sleep(10); }
async function pick(el: FakeElement, v: string) { flushSync(() => props(el).onChange({ target: { value: v }, currentTarget: { value: v } })); await sleep(10); }
const flashButton = () => container.findAll((e) => e.tagName === "BUTTON" && text(e).startsWith("Flash"))[0];
const disabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function record(bytes: number[]) { return ":" + [...bytes, (-bytes.reduce((a, b) => a + b, 0)) & 255].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(); }
const HEX = [record([2, 0, 0, 4, 8, 0]), record([16, 0, 0, 0, 0, 0, 1, 32, 9, 0, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8]), record([0, 0, 0, 1])].join("\n");

async function page(scenario: BoardIdMockScenario | undefined, connected = true) {
  const { host } = await gatedMock(scenario);
  (globalThis as any).__setupTestHost = { host, connectionStatus: connected ? "connected" : "disconnected", postFlashGate: false,
    setPostFlashGate: () => {}, clearPostFlashGateAfterReconnect: async () => false };
  const root = createRoot(container as never); flushSync(() => root.render(<FlasherPage />));
  return root;
}
async function readyMockFlash(file = "bobflight.hex") {
  await check(byId("INPUT", "props-off"), true); await check(byId("INPUT", "backup-taken"), true);
  await check(byId("INPUT", "use-mock-flash"), true); await check(byId("INPUT", "mock-understood"), true);
  flushSync(() => props(byId("INPUT", "hex-file")).onChange({ target: { files: [{ name: file, size: HEX.length, text: async () => HEX }] } }));
  await sleep(30);
}
{ // match: pre-selected in flasher + HEX builder, tokens verbatim, no manual confirm
  const root = await page("match");
  assert(await waitFor(() => byId("SELECT", "board").value === "kakute_f7_hdv" || props(byId("SELECT", "board")).value === "kakute_f7_hdv"));
  assert.equal(text(byId("CODE", "fc-board-id")), "kakute_f7_hdv"); assert.equal(text(byId("CODE", "fc-board-mcu")), "stm32f745");
  assert.equal(text(byId("CODE", "hex-board-marker")), "unknown");
  assert.equal(byId("INPUT", "manual-board-confirm"), undefined);
  assert(text(container).includes("Kakute F7 HDV development firmware") || text(container).includes("Build"), "HEX builder rendered for the pre-selected board");
  flushSync(() => root.unmount());
}
{ // old firmware: unknown, manual pick needs the explicit confirm (mock flash path)
  const root = await page("old-firmware");
  assert(await waitFor(() => text(container).includes("older firmware")));
  assert.equal(text(byId("CODE", "fc-board-id")), "unknown"); assert.equal(props(byId("SELECT", "board")).value, "");
  await pick(byId("SELECT", "board"), "tmotor_f7_v2"); await readyMockFlash();
  assert(disabled(flashButton()), "manual selection blocked until confirmed");
  await check(byId("INPUT", "manual-board-confirm"), true); assert(!disabled(flashButton()));
  flushSync(() => root.unmount());
}
{ // unknown id: verbatim, nothing pre-selected
  const root = await page("unknown-id");
  assert(await waitFor(() => text(byId("CODE", "fc-board-id")) === "acme_f7_prototype"));
  assert.equal(props(byId("SELECT", "board")).value, "");
  flushSync(() => root.unmount());
}
{ // MCU mismatch: hard block, no confirm offered, Flash disabled even with everything ticked
  const root = await page("mcu-mismatch");
  assert(await waitFor(() => text(container).includes("MCU mismatch")));
  await readyMockFlash();
  assert.equal(byId("INPUT", "manual-board-confirm"), undefined); assert(disabled(flashButton()));
  flushSync(() => root.unmount());
}
{ // board mismatch: user picks a different board than the FC reports
  const root = await page("board-mismatch");
  assert(await waitFor(() => props(byId("SELECT", "board")).value === "matek_f722_px"));
  await pick(byId("SELECT", "board"), "kakute_f7_hdv"); await readyMockFlash();
  assert(text(container).includes("Board mismatch")); assert(disabled(flashButton()));
  flushSync(() => root.unmount());
}
{ // malformed: shown as unknown + verbatim, never pre-selected
  const root = await page("malformed");
  assert(await waitFor(() => text(byId("CODE", "fc-board-id")) === "unknown (Kakute F7 HDV!)"));
  assert.equal(props(byId("SELECT", "board")).value, "");
  flushSync(() => root.unmount());
}
console.log("PASS FlasherPage: pre-select on match, verbatim/unknown display, manual confirm, MCU and board mismatch block flashing");
