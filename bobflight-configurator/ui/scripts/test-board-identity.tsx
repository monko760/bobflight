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
import { CommandGate, GATE_QUEUE_LIMIT } from "../src/protocol/commandGate";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { readBoardIdentity, identityView, identityGate } from "../src/flasher/boardIdentity";
import { BOARD_OPTIONS } from "../src/flasher/types";
import { RPM_GATE_ATTEMPTS, RPM_GATE_DELAY_MS } from "../src/filters/rpmFilter";
import { BOARD_ID_MOCK_SCENARIOS, BobFlightCliClient, parseBoardIdentity, type BoardIdMockScenario } from "@bobflight/protocol";
import { EventEmitter } from "node:events";
import { scenario as dfu } from "./fixtures/flasherBackendStub";
import replies from "./fixtures/version-replies.json";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(10); } return pred(); }
const kakute = BOARD_OPTIONS.find((b) => b.boardId === "kakute_f7_hdv")!;
const matek = BOARD_OPTIONS.find((b) => b.boardId === "matek_f722_px")!;

/** A real gate in front of the real mock host, as createHost wires it. */
async function gatedMock(scenario: BoardIdMockScenario | undefined, queueLimit = GATE_QUEUE_LIMIT) {
  const mock = new MockBobFlightHost({ connectDelayMs: 0, boardIdScenario: scenario });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const gate = new CommandGate(() => 1, queueLimit);
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
  const full = (a: string, t = "stm32f745", m = "stm32f745") => `BobFlight x\r\nboard_id: ${a}\r\nboard_target: ${t}\r\nboard_mcu: ${m}\r\n`;
  for (const ok of ["a", "0-9_z", "custom_f405xg_usb", "a".repeat(48)]) assert.equal(parseBoardIdentity(full(ok)).board_id.kind, "value", ok);
  assert.deepEqual(parseBoardIdentity(full("a".repeat(49))).board_id, { kind: "malformed", raw: "a".repeat(49) }, "48-character cap");
  assert.equal(parseBoardIdentity("BobFlight 0.2.0\r\n").board_id.kind, "missing");
  // CRLF-terminated lines only: LF-only, CR-only and an unterminated tail are never trusted.
  const lf = parseBoardIdentity("board_id: kakute_f7_hdv\nboard_target: stm32f745\nboard_mcu: stm32f745\n");
  assert(Object.values(lf).every((f) => f.kind !== "value"), "LF-only not trusted");
  assert(Object.values(parseBoardIdentity(full("kakute_f7_hdv").replace(/\r\n/g, "\r"))).every((f) => f.kind !== "value"), "CR-only not trusted");
  const tail = parseBoardIdentity(full("kakute_f7_hdv").slice(0, -2));
  assert.equal(tail.board_mcu.kind, "missing", "unterminated last line is ignored");
  // All three keys required: one bad/missing key makes all three untrusted (shown unknown).
  for (const id of [tail, parseBoardIdentity("board_id: kakute_f7_hdv\r\nboard_mcu: stm32f745\r\n"), parseBoardIdentity(full("kakute_f7_hdv", "stm32f745", "STM32F745"))])
    for (const k of ["board_id", "board_target", "board_mcu"] as const) assert.notEqual(id[k].kind, "value", k);
  assert.deepEqual(tail.board_id, { kind: "malformed", raw: "kakute_f7_hdv" }, "valid-looking value of an incomplete identity is shown as unknown (<verbatim>)");
  // X12: a duplicate key (even with the same value) reads unknown, never first-wins.
  for (const dup of [full("kakute_f7_hdv") + "board_id: matek_f722_px\r\n", full("kakute_f7_hdv") + "board_id: kakute_f7_hdv\r\n", full("kakute_f7_hdv") + "board_mcu: stm32f722\r\n"]) {
    const id = parseBoardIdentity(dup);
    for (const k of ["board_id", "board_target", "board_mcu"] as const) assert.notEqual(id[k].kind, "value", `duplicate: ${k}`);
    assert.equal(identityView({ kind: "read", identity: id }).preselect, null);
  }
  assert.deepEqual(parseBoardIdentity(full("kakute_f7_hdv") + "board_id: matek_f722_px\r\n").board_id, { kind: "malformed", raw: "kakute_f7_hdv | matek_f722_px" });
  console.log("PASS parser: [a-z0-9_-]{1,48} tokens on CRLF lines only; all three keys required; duplicate key unknown (X12)");
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
    assert.equal(v.boardId, "acme_f7_prototype", "verbatim"); assert.equal(v.preselect, null); assert.match(v.note!, /not known to this Configurator/);
    // A valid board_id that no catalog board equals is a board_id mismatch for every selection:
    // blocked, and a manual confirm cannot override it.
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true); assert.equal(g.needsConfirm, false);
    assert(g.reasons.some((r) => r.startsWith("Unknown board")));
    assert.equal(identityGate(v, undefined, null, true).blocked, true, "unknown board blocks with no override");
    assert(identityGate(v, matek, "F722", true).reasons.some((r) => r.startsWith("MCU mismatch")), "board_mcu still gates");
  },
  "board-mismatch": (v) => {
    assert.equal(v.boardId, "matek_f722_px"); assert.equal(v.preselect, "matek_f722_px");
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true); assert.equal(g.needsConfirm, false);
    assert(g.reasons.some((r) => r.startsWith("Board mismatch")));
    assert.equal(identityGate(v, matek, "F722", false).blocked, false);
  },
  "mcu-mismatch": (v) => {
    assert.equal(v.boardId, "kakute_f7_hdv"); assert.equal(v.mcu, "stm32f722"); assert.equal(v.preselect, null, "catalog MCU differs: nothing pre-selected");
    const g = identityGate(v, kakute, "F745", true); assert.equal(g.blocked, true, "MCU mismatch blocks whatever the board_id");
    assert(g.reasons.some((r) => r.startsWith("MCU mismatch")));
    assert.equal(identityGate(v, matek, "F722", true).blocked, true, "and a board_id mismatch also blocks");
  },
  malformed: (v) => {
    assert.equal(v.boardId, "unknown (Kakute F7 HDV!)"); assert.equal(v.mcu, "unknown (STM32F745)"); assert.equal(v.target, "unknown (stm32f745)");
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
  // P1: queue bound 0 reproduces the gate's overflow busy refusal (the retry path this section covers).
  const { host, gate, sends } = await gatedMock("match", 0);
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
  assert(byId("INPUT", "manual-board-confirm"), "live DFU default: the confirm is always offered, even on a match");
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
  assert(await waitFor(() => text(byId("CODE", "fc-board-mcu")) === "stm32f722"));
  assert.equal(props(byId("SELECT", "board")).value, "", "catalog MCU differs: not pre-selected");
  await pick(byId("SELECT", "board"), "kakute_f7_hdv");
  assert(text(container).includes("MCU mismatch"));
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

// ---------- 5. B2/B3: auto-match only for three valid, consistent, catalog-equal values ----------
{
  const view = (a: string, t: string, m: string) => identityView({ kind: "read", identity: parseBoardIdentity(`board_id: ${a}\r\nboard_target: ${t}\r\nboard_mcu: ${m}\r\n`) });
  const ok = view("kakute_f7_hdv", "stm32f745", "stm32f745");
  assert.equal(identityGate(ok, kakute, "F745", false).needsConfirm, false);
  const incons = view("kakute_f7_hdv", "stm32f722", "stm32f745");
  assert.equal(incons.preselect, null); assert.equal(incons.fcBoardId, null); assert.match(incons.note!, /board_target stm32f722 differs from board_mcu stm32f745/);
  const g = identityGate(incons, kakute, "F745", false); assert.equal(g.needsConfirm, true); assert.equal(g.blocked, true, "inconsistent target never auto-matches");
  // B3: board_target gates on its own (a hand-built view where only target is wrong).
  const tgt = identityGate({ ...ok, fcTarget: "stm32f722" }, kakute, "F745", true);
  assert.equal(tgt.blocked, true); assert(tgt.reasons.some((r) => r.startsWith("MCU mismatch: flight controller reports board_target stm32f722")));
  // B2: catalog MCU must equal board_mcu even when the id matches.
  const wrongMcu = identityGate({ ...ok, fcTarget: "stm32f722", fcMcu: "stm32f722" }, kakute, null, true);
  assert.equal(wrongMcu.blocked, true); assert.equal(wrongMcu.needsConfirm, false);
  console.log("PASS B2/B3: auto-match needs id+target+mcu valid, target==mcu==catalog; board_target gates");
}

// ---------- 6. cut replies: real host bytes, a 150 ms pause, the real client and gate ----------
class PausedPort extends EventEmitter {
  readonly path = "test://cut"; readonly baudRate = 115200; isOpen = true;
  constructor(private reply: () => [string, string]) { super(); }
  async open() { this.isOpen = true; } async close() { this.isOpen = false; this.emit("close"); }
  write(data: string | Buffer) {
    if (String(data).trim() !== "version") return true;
    const [a, b] = this.reply();
    setTimeout(() => this.emit("data", Buffer.from(a, "latin1")), 1);
    if (b) setTimeout(() => this.emit("data", Buffer.from(b, "latin1")), 151);
    return true;
  }
}
async function realClient(reply: () => [string, string]) {
  const port = new PausedPort(reply);
  const client = new BobFlightCliClient({ enumerate: async () => [], open: async () => port as never });
  await client.connect({ path: port.path, baudRate: 115200 } as never);
  const gate = new CommandGate(() => 1);
  return { host: { sendCommand: (c: "version") => gate.run(() => client.sendCommand(c)) }, client };
}
{
  let cuts = 0;
  for (const [boardId, bytes] of Object.entries(replies).filter(([k]) => !k.startsWith("_")) as [string, string][]) {
    const board = BOARD_OPTIONS.find((b) => b.boardId === boardId)!;
    const whole = await realClient(() => [bytes, ""]);
    const wv = identityView(await readBoardIdentity(whole.host));
    assert.equal(wv.preselect, boardId, `${boardId}: uncut real reply auto-matches ${JSON.stringify(wv)}`);
    assert.equal(identityGate(wv, board, board.mcu, false).blocked, false); await whole.client.disconnect();
    // Every cut from the start of board_id to the last byte, which includes every cut inside
    // the board_id and board_mcu values.
    const from = bytes.indexOf("board_id:");
    for (let cut = from; cut < (process.env.QUICK_CUTS ? from + 1 : bytes.length); cut++) {
      const { host, client } = await realClient(() => [bytes.slice(0, cut), bytes.slice(cut)]);
      const r = await readBoardIdentity(host); assert.equal(r.kind, "read");
      const v = identityView(r);
      const at = JSON.stringify(bytes.slice(Math.max(0, cut - 12), cut));
      assert.equal(v.fcBoardId, null, `${boardId} cut ${at}`); assert.equal(v.fcMcu, null); assert.equal(v.fcTarget, null); assert.equal(v.preselect, null);
      for (const shown of [v.boardId, v.target, v.mcu]) assert.match(shown, /^unknown/, `${boardId} cut ${at}: ${shown}`);
      const g = identityGate(v, board, board.mcu, false);
      assert(!g.reasons.some((x) => /mismatch|Unknown board/.test(x)), `${boardId} cut ${at}: no false mismatch: ${g.reasons}`);
      assert.equal(g.needsConfirm, true, "cut reply: manual confirm"); assert.equal(identityGate(v, board, board.mcu, true).blocked, false);
      assert.equal(v.canRetry, true, "cut reply offers Read again");
      await sleep(170); // the late half lands between commands
      const again = identityView(await readBoardIdentity(host));
      assert(again.preselect === boardId || again.fcBoardId === null, `${boardId} cut ${at}: re-read is a match or unknown, never a different board`);
      await client.disconnect(); cuts++;
    }
  }
  // Matek: the 96-byte version truncation is before the board lines and can't cut them.
  const m = (replies as Record<string, string>).matek_f722_px;
  assert.equal(m.indexOf("\r\n"), 95, "Matek version line is the truncated 95-character line"); assert(m.slice(97).startsWith("board_id: matek_f722_px\r\n"));
  console.log(`PASS cut replies: ${cuts} cuts across the board lines of kakute/matek/tmotor real bytes via real client+gate: all unknown, no false mismatch`);
}

// ---------- 7. FlasherPage: X8, X9, Read again, stale identity across DFU ----------
const select = () => byId("SELECT", "board");
const idText = () => text(byId("CODE", "fc-board-id"));
const pickDfu = async () => { dfu.pick = async () => ({ vendorId: 0x0483, productId: 0xdf11, productName: "DFU" });
  flushSync(() => props(container.findAll((e) => e.tagName === "BUTTON" && text(e).startsWith("Select DFU device"))[0]).onClick({})); await sleep(30); };
async function setConn(host: unknown, status: string) {
  (globalThis as any).__setupTestHost = { ...(globalThis as any).__setupTestHost, host, connectionStatus: status };
}
{ // X9: auto-detect never overrides a selection the user already made
  const { host } = await gatedMock("match");
  (globalThis as any).__setupTestHost = { host, connectionStatus: "disconnected", postFlashGate: false, setPostFlashGate: () => {}, clearPostFlashGateAfterReconnect: async () => false };
  const root = createRoot(container as never); flushSync(() => root.render(<FlasherPage />));
  await pick(select(), "matek_f722_px");
  await setConn(host, "connected"); flushSync(() => root.render(<FlasherPage />));
  assert(await waitFor(() => idText() === "kakute_f7_hdv"));
  assert.equal(props(select()).value, "matek_f722_px", "X9: user's selection kept");
  assert(text(container).includes("Board mismatch"));
  flushSync(() => root.unmount());
}
{ // X8: the manual confirm resets when the board changes
  const root = await page("old-firmware"); assert(await waitFor(() => text(container).includes("older firmware")));
  await pick(select(), "tmotor_f7_v2"); await check(byId("INPUT", "manual-board-confirm"), true);
  assert.equal(byId("INPUT", "manual-board-confirm").checked, true);
  await pick(select(), "matek_f722_px");
  assert.equal(byId("INPUT", "manual-board-confirm").checked, false, "X8: confirm reset on board change");
  flushSync(() => root.unmount());
}
{ // Read again: a failed read offers a re-read that then auto-matches
  const mock = new MockBobFlightHost({ connectDelayMs: 0, boardIdScenario: "match" });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  let calls = 0; const gate = new CommandGate(() => 1);
  const host = { sendCommand: (c: "version") => gate.run(() => { calls++; if (calls === 1) return Promise.reject(new Error("transport glitch")); return mock.sendCommand(c); }) };
  (globalThis as any).__setupTestHost = { host, connectionStatus: "connected", postFlashGate: false, setPostFlashGate: () => {}, clearPostFlashGateAfterReconnect: async () => false };
  const root = createRoot(container as never); flushSync(() => root.render(<FlasherPage />));
  assert(await waitFor(() => text(container).includes("transport glitch")));
  const again = byId("BUTTON", "board-identity-reread"); assert(again, "Read again shown"); assert.equal(text(again), "Read again");
  flushSync(() => props(again).onClick({}));
  assert(await waitFor(() => props(select()).value === "kakute_f7_hdv")); assert.equal(calls, 2);
  assert.equal(byId("BUTTON", "board-identity-reread"), undefined, "no Read again once matched");
  flushSync(() => root.unmount());
}
async function liveReady(boardId: string) {
  if (props(select()).value !== boardId) await pick(select(), boardId);
  flushSync(() => props(byId("INPUT", "hex-file")).onChange({ target: { files: [{ name: "bobflight.hex", size: HEX.length, text: async () => HEX }] } })); await sleep(30);
  await pickDfu(); await check(byId("INPUT", "props-off"), true); await check(byId("INPUT", "backup-taken"), true);
  await check(byId("INPUT", "board-match-confirmed"), true);
}
/** Live DFU: Flash stays disabled and onFlash refuses until the manual confirm is ticked. */
async function confirmRequired(why: string) {
  const box = byId("INPUT", "manual-board-confirm"); assert(box, `${why}: manual confirm offered`);
  assert.equal(box.checked, false, why);
  assert(disabled(flashButton()), `${why}: Flash disabled without the confirm`);
  const before = dfu.flashes; flushSync(() => props(flashButton()).onClick({})); await sleep(30);
  assert.equal(dfu.flashes, before, `${why}: onFlash refuses without the confirm`);
  await check(box, true);
  assert(!disabled(flashButton()), `${why}: confirm enables Flash (${flashButton().getAttribute("title")})`);
}
const cdcOff = async (root: ReturnType<typeof createRoot>) => {
  (globalThis as any).__setupTestHost = { ...(globalThis as any).__setupTestHost, connectionStatus: "disconnected" };
  flushSync(() => root.render(<FlasherPage />)); await sleep(10);
};
const replug = async () => { flushSync(() => (navigator as any).usb.dispatchEvent(new Event("disconnect"))); await sleep(20); };
{ // Ruling (c): identity matches exactly -> pre-selected, still the manual confirm in DFU
  const root = await page("match"); assert(await waitFor(() => props(select()).value === "kakute_f7_hdv"));
  await cdcOff(root); await liveReady("kakute_f7_hdv");
  assert.equal(idText(), "kakute_f7_hdv", "identity kept for pre-select");
  await confirmRequired("exact match");
  // X8 (file): replacing the file resets the manual confirm.
  flushSync(() => props(byId("INPUT", "hex-file")).onChange({ target: { files: [{ name: "other.hex", size: HEX.length, text: async () => HEX }] } })); await sleep(30);
  assert.equal(byId("INPUT", "manual-board-confirm").checked, false, "X8: confirm reset on file change");
  flushSync(() => root.unmount());
}
{ // after an acknowledged `bl` in the same CDC session: still the confirm
  const root = await page("match"); assert(await waitFor(() => idText() === "kakute_f7_hdv"));
  const host = (globalThis as any).__setupTestHost.host;
  (globalThis as any).__setupTestHost = { ...(globalThis as any).__setupTestHost, host: { ...host, sendCommand: async (c: string) => c === "bl" ? "bl: resetting to ST ROM bootloader\r\n" : host.sendCommand(c) } };
  assert.match(await (globalThis as any).__setupTestHost.host.sendCommand("bl"), /resetting to ST ROM bootloader/);
  await cdcOff(root); await liveReady("kakute_f7_hdv");
  await confirmRequired("after bl ack, same session");
  flushSync(() => root.unmount());
}
{ // after a re-plug: identity stale (unknown) and the confirm
  const root = await page("match"); assert(await waitFor(() => idText() === "kakute_f7_hdv"));
  await cdcOff(root); await pickDfu(); await replug();
  assert.equal(idText(), "unknown", "re-plug: identity unknown"); assert.match(text(byId("P", "board-identity-note")), /disconnected/);
  await liveReady("kakute_f7_hdv"); await confirmRequired("after re-plug");
  flushSync(() => root.unmount());
}
{ // same-MCU board swap: FC reported matek (F722), a T-Motor (F722) is in DFU. Pre-select is matek.
  const root = await page("board-mismatch"); assert(await waitFor(() => props(select()).value === "matek_f722_px"));
  await cdcOff(root); await liveReady("matek_f722_px");
  await confirmRequired("same-MCU swap");
  // Mismatch still hard-blocks: selecting the swapped-in board against the detected id.
  await pick(select(), "tmotor_f7_v2"); assert(text(container).includes("Board mismatch"));
  assert.equal(byId("INPUT", "manual-board-confirm"), undefined, "mismatch: no confirm override"); assert(disabled(flashButton()));
  flushSync(() => root.unmount());
}
{ // Mismatch blocks across the DFU pick, and a stale one clears after a re-plug (no reconnect)
  const root = await page("board-mismatch"); assert(await waitFor(() => props(select()).value === "matek_f722_px"));
  await pick(select(), "kakute_f7_hdv"); await cdcOff(root); await liveReady("kakute_f7_hdv");
  assert(text(container).includes("Board mismatch"), "detected mismatch still blocks in DFU"); assert(disabled(flashButton()));
  await replug(); assert(!text(container).includes("Board mismatch"), "stale mismatch cleared by re-plug");
  await liveReady("kakute_f7_hdv"); await confirmRequired("after stale mismatch cleared");
  flushSync(() => root.unmount());
}
{ // MCU mismatch (board_mcu / board_target) still blocks in DFU
  const root = await page("mcu-mismatch"); assert(await waitFor(() => idText() === "kakute_f7_hdv"));
  await pick(select(), "kakute_f7_hdv"); await cdcOff(root); await liveReady("kakute_f7_hdv");
  assert(text(container).includes("MCU mismatch")); assert.equal(byId("INPUT", "manual-board-confirm"), undefined); assert(disabled(flashButton()));
  flushSync(() => root.unmount());
}
{ // gate API: in DFU the confirm is needed even for a trusted exact match; mock path keeps auto-match
  const ok = identityView({ kind: "read", identity: parseBoardIdentity("board_id: kakute_f7_hdv\r\nboard_target: stm32f745\r\nboard_mcu: stm32f745\r\n") });
  assert.equal(identityGate(ok, kakute, "F745", false, true).needsConfirm, true);
  assert.equal(identityGate(ok, kakute, "F745", false, true).blocked, true);
  assert.equal(identityGate(ok, kakute, "F745", true, true).blocked, false);
  assert.equal(identityGate(ok, matek, "F722", true, true).blocked, true, "mismatch blocks in DFU even confirmed");
}
{ // Gate on its own (defensive API): an untrusted id/mcu/target never auto-matches
  const ok = identityView({ kind: "read", identity: parseBoardIdentity("board_id: kakute_f7_hdv\r\nboard_target: stm32f745\r\nboard_mcu: stm32f745\r\n") });
  for (const v of [{ ...ok, fcBoardId: null }, { ...ok, fcMcu: null }, { ...ok, fcTarget: null }, { ...ok, fcMcu: null, fcTarget: null }])
    assert.equal(identityGate(v, kakute, "F745", false).needsConfirm, true, JSON.stringify(v));
}
console.log("PASS FlasherPage: X8 confirm reset, X9 selection kept, Read again, DFU confirm always required (match, bl ack, re-plug, same-MCU swap), mismatch blocks, stale mismatch cleared by re-plug");
