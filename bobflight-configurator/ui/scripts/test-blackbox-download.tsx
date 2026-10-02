/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Render test for the Blackbox tab SD download (BB2a): the real BlackboxPage in
 * the #57 fake DOM (useHost and saveBlob stubbed by run-blackbox-download.mjs)
 * over the real BobFlightCliClient, the real UI CommandGate and the protocol
 * SdSectorReader, talking to a FW-faithful `sd` CLI model with a sparse FAT32
 * card (protocol/src/sd-read-mock.ts). Asserts what a user sees (visible text
 * only), what was sent on the wire, and what was saved.
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { savedFiles } from "./fixtures/saveBlobStub";
import { BlackboxPage } from "../src/pages/BlackboxPage";
import { CommandGate } from "../src/protocol/commandGate";
import { SdDownloadController } from "../src/blackbox/sdDownload";
import {
  BobFlightCliClient,
  SdSectorReader,
  parseStatus,
  SD_DATA_ERROR_TEXTS,
  SD_PROBE_REFUSALS,
  SD_PROBE_TIMEOUT_MS,
  type CliCommand,
} from "@bobflight/protocol";
import { SparseFat32Card, MockSdCliFirmware, SdSimTransportFactory, type MockSdFirmwareOptions } from "../../protocol/src/sd-read-mock";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(5); }
  return pred();
}

// ---- what a user sees -------------------------------------------------------
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
/** Hidden to a user: hidden attr, aria-hidden, display:none, visibility:hidden, opacity 0, screen-reader-only classes. */
function isHidden(e: FakeElement): boolean {
  const cls = (e.getAttribute("class") ?? "").split(/\s+/);
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" ||
    e.style.visibility === "hidden" || e.style.opacity === "0" || cls.includes("sr-only") || cls.includes("visually-hidden");
}
/** Text a user can see: hidden subtrees skipped, closed <details> show only their <summary>. */
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  const kids = n.tagName === "DETAILS" && !n.hasAttribute("open") ? n.childNodes.filter((c) => isEl(c) && c.tagName === "SUMMARY") : n.childNodes;
  return kids.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTestId = (id: string) => container.findAll((e) => e.getAttribute("data-testid") === id)[0] ?? null;
/** Visible text of a test id, or null when absent/hidden anywhere up the tree. */
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
  assert.ok(b, `button "${text}" rendered; buttons: ${container.findAll((e) => e.tagName === "BUTTON").map((e) => visibleText(e).trim()).join(" | ")}`);
  return b;
}
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
function click(text: string) {
  const b = button(text);
  assert.ok(!isDisabled(b), `button "${text}" is enabled`);
  flushSync(() => reactProps(b).onClick({}));
}
const fileRows = () => container.findAll((e) => e.tagName === "TR" && e.hasAttribute("data-file"))
  .map((tr) => tr.childNodes.filter(isEl).slice(0, 2).map((td) => visibleText(td).trim()));
const counterRows = () => (byTestId("bb-fc-counters")?.childNodes ?? []).filter(isEl)
  .map((d) => [d.getAttribute("data-key"), visibleText(d.childNodes.filter(isEl)[1]).trim()]);

// ---- rig: real client + real CommandGate + SdSectorReader over the FW model -----
interface Rig {
  fw: MockSdCliFirmware; card: SparseFat32Card; factory: SdSimTransportFactory; client: BobFlightCliClient;
  ctx: Record<string, unknown>; root: Root; rerender(): void; setVisible(v: boolean): void;
  hostReads: { current: number; max: number }; wireReads: { current: number; max: number };
  mark(): number; sdSince(mark: number): string[]; done(): Promise<void>;
}
const FILES = [
  { name: "BFL00001.BBL", size: 40116, clusters: [3, 4, 5] },
  { name: "BFL00002.BBL", size: 700, clusters: [6] },
  { name: "BFL00003.BBL", size: 20000, clusters: [10, 7] },
];
const RECORDING_STATUS = "blackbox_api: 2\r\nblackbox_state: recording\r\nblackbox_reason: recording\r\nblackbox_file: BFL00004.BBL\r\nblackbox_bytes: 1024\r\nblackbox_frames: 10\r\nblackbox_rate_hz: 500\r\nblackbox_dropped: 0\r\nblackbox_missed: 0\r\nblackbox_invalid: 0\r\nblackbox_queue: 0\r\nblackbox_active: 1\r\nblackbox_rate_requested_hz: 500\r\nblackbox_rate_reason: default\r\nblackbox_drop_pct: 0.0\r\nblackbox_end: 1\r\n";

async function rig(fwOpts: MockSdFirmwareOptions = {}, readTimeoutMs = 4000): Promise<Rig> {
  savedFiles().length = 0;
  const card = fwOpts.card ?? new SparseFat32Card({ files: FILES });
  const fw = new MockSdCliFirmware({ ...fwOpts, card });
  const factory = new SdSimTransportFactory(fw);
  const client = new BobFlightCliClient(factory);
  await client.connect({ path: "sim://bobflight-sd", transport: "serial" });
  await sleep(5);
  let generation = 0;
  const gate = new CommandGate(() => generation);
  const hostReads = { current: 0, max: 0 };
  const wireReads = { current: 0, max: 0 };
  const reader = new SdSectorReader(gate, async (cmd, opts) => {
    wireReads.max = Math.max(wireReads.max, ++wireReads.current);
    try { return await client.sendCommand(cmd, opts); } finally { wireReads.current--; }
  }, readTimeoutMs);
  const host = {
    getConnectionStatus: () => client.getConnectionStatus(),
    sendCommand: (cmd: CliCommand) => gate.run(() => client.sendCommand(cmd)),
    readSdSector: async (sector: number) => {
      hostReads.max = Math.max(hostReads.max, ++hostReads.current);
      try { return await reader.read(sector); } finally { hostReads.current--; }
    },
  };
  let visible = true;
  let root: Root | null = null;
  const rerender = () => { if (root) flushSync(() => root!.render(<BlackboxPage visible={visible} />)); };
  const ctx: Record<string, unknown> = {
    host, connectionStatus: client.getConnectionStatus(), version: "BobFlight 0.1.0-sdsim", status: null, postFlashGate: false,
    refreshStatus: async () => { const raw = await host.sendCommand("status"); ctx.status = parseStatus(raw); setTimeout(rerender, 0); },
    pollAfterConnect: async () => {}, setLastError: () => {},
  };
  client.onStatus((s) => { generation++; ctx.connectionStatus = s; if (root) setTimeout(rerender, 0); });
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  root = createRoot(container as never);
  rerender();
  // The page's own polls tell it the recorder state and arm state before the user acts.
  assert.ok(await waitFor(() => fw.log.includes("blackbox status") && fw.log.includes("status") && !!ctx.status, 4000), `initial polls: ${fw.log.join(", ")}`);
  await sleep(20);
  return {
    fw, card, factory, client, ctx, root, rerender, hostReads, wireReads,
    setVisible(v: boolean) { visible = v; rerender(); },
    mark: () => fw.log.length,
    sdSince: (m: number) => fw.log.slice(m).filter((l) => l.startsWith("sd ")),
    async done() { root!.unmount(); root = null; await client.disconnect(); await sleep(5); },
  };
}

const IDLE = "No SD download in progress.";
async function listCard(r: Rig) {
  click("Probe card and list logs");
  assert.ok(await waitFor(() => shown("bb-download-phase") === IDLE && fileRows().length > 0), `files listed; message: ${shown("bb-download-message")}`);
}
async function expectMessage(re: RegExp, ms = 8000) {
  const ok = await waitFor(() => shown("bb-download-phase") === IDLE && re.test(shown("bb-download-message") ?? ""), ms);
  assert.ok(ok, `message ${re} visible; got phase "${shown("bb-download-phase")}" message "${shown("bb-download-message")}"`);
}
const dataLba = (r: Rig, name: string, sectorIndex: number) => r.card.fileSectorLba(name, sectorIndex * 512);
async function savedBytes(i = 0) { return new Uint8Array(await savedFiles()[i].blob.arrayBuffer()); }
const readsOf = (r: Rig, lba: number, since = 0) => r.fw.log.slice(since).filter((l) => l === `sd read ${lba}`).length;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await test("lists 3 BFL*.BBL files with sizes from a sparse FAT32 card and downloads multi-cluster + fragmented files (fresh probe first, sd cancel last, one sd read in flight, progress + measured rate)", async () => {
    const r = await rig({ readDelayMs: 2 });
    let m = r.mark();
    await listCard(r);
    assert.deepEqual(fileRows(), [["BFL00001.BBL", "40,116"], ["BFL00002.BBL", "700"], ["BFL00003.BBL", "20,000"]]);
    let sd = r.sdSince(m);
    assert.equal(sd[0], "sd probe", `list starts with a fresh probe: ${sd.slice(0, 3)}`);
    assert.equal(sd[1], "sd status", "then polls sd status");
    assert.equal(sd.at(-1), "sd cancel", "and finishes with sd cancel");
    assert.match(shown("bb-download-message") ?? "", /Found 3 log files in the card root\. Sent sd cancel\./);

    m = r.mark();
    click("Download BFL00001.BBL");
    assert.ok(await waitFor(() => /of 40,116 bytes · \d+ of 79 sectors/.test(shown("bb-download-progress") ?? "")), `progress visible: ${shown("bb-download-progress")}`);
    assert.ok(isDisabled(button("Probe card and list logs")) && !isDisabled(button("Cancel download")), "List locked and Cancel available while downloading");
    await expectMessage(/^Saved BFL00001\.BBL: 40,116 bytes, 79 sectors CRC-verified\. Sent sd cancel\.$/);
    sd = r.sdSince(m);
    assert.equal(sd[0], "sd probe", "download re-probes even though the list just probed");
    assert.equal(sd.at(-1), "sd cancel");
    assert.ok(sd.indexOf("sd cancel") === sd.length - 1, "sd cancel only at the end");
    assert.match(shown("bb-download-progress") ?? "", /^40,116 of 40,116 bytes · 79 of 79 sectors · \d+(\.\d)? (KiB|B)\/s$/, "rate measured from real timings");
    assert.equal(savedFiles().length, 1);
    assert.equal(savedFiles()[0].name, "BFL00001.BBL");
    assert.deepEqual(Buffer.from(await savedBytes(0)), Buffer.from(r.card.payload("BFL00001.BBL")));
    // Every data sector of the 3-cluster chain was read exactly once, in order.
    const expected = Array.from({ length: 79 }, (_, i) => `sd read ${dataLba(r, "BFL00001.BBL", i)}`);
    const reads = r.fw.log.slice(m).filter((l) => l.startsWith("sd read "));
    assert.deepEqual(reads.slice(-79), expected);

    m = r.mark();
    click("Download BFL00003.BBL");
    await expectMessage(/^Saved BFL00003\.BBL: 20,000 bytes, 40 sectors CRC-verified\. Sent sd cancel\.$/);
    assert.deepEqual(Buffer.from(await savedBytes(1)), Buffer.from(r.card.payload("BFL00003.BBL")), "fragmented chain 10 -> 7");
    assert.equal(r.sdSince(m)[0], "sd probe");
    assert.equal(r.hostReads.max, 1, "the page never requests a second sd read while one is outstanding");
    assert.equal(r.wireReads.max, 1, "exactly one sd read on the wire at a time");
    assert.equal(r.fw.readsWhileActive, 0, "FW never saw a read while another was active");
    assert.ok(!r.fw.log.some((l) => l === "sd read" || / 0\d/.test(l)), "canonical sector numbers only");
    await r.done();
  });

  await test("CRC mismatch once on a sector: re-read once, file saved intact", async () => {
    const r = await rig();
    await listCard(r);
    const lba = dataLba(r, "BFL00001.BBL", 40);
    r.fw.addFault(lba, { type: "crc" });
    const m = r.mark();
    click("Download BFL00001.BBL");
    await expectMessage(/^Saved BFL00001\.BBL: 40,116 bytes/);
    assert.equal(readsOf(r, lba, m), 2, "the corrupted sector was retried once");
    assert.deepEqual(Buffer.from(await savedBytes()), Buffer.from(r.card.payload("BFL00001.BBL")));
    await r.done();
  });

  await test("CRC mismatch twice: abort naming the sector, nothing saved, sd cancel sent", async () => {
    const r = await rig();
    await listCard(r);
    const lba = dataLba(r, "BFL00001.BBL", 40);
    r.fw.addFault(lba, { type: "crc" }, { type: "crc" });
    const m = r.mark();
    click("Download BFL00001.BBL");
    await expectMessage(new RegExp(`^CRC mismatch on sector ${lba} \\(FC sent [0-9A-F]{8}, data computes to [0-9A-F]{8}\\) after one retry\\. Download aborted\\. Nothing was saved\\. Sent sd cancel\\.$`));
    assert.ok(pageText().includes(`CRC mismatch on sector ${lba}`));
    assert.equal(byTestId("bb-download-result")?.getAttribute("role"), "alert");
    assert.equal(savedFiles().length, 0, "no file saved");
    assert.equal(readsOf(r, lba, m), 2, "retried at most once");
    const sd = r.sdSince(m);
    assert.equal(sd.at(-1), "sd cancel");
    assert.equal(sd.at(-2), `sd read ${lba}`, "no read after the failed sector");
    assert.equal(shown("bb-download-progress"), null, "partial progress/data discarded");
    await r.done();
  });

  await test("every sd_data_error line (immediate, mid-read async, host sim, unknown future) is shown verbatim and visible; download stops; nothing saved; sd cancel sent", async () => {
    const r = await rig();
    await listCard(r);
    const lba = dataLba(r, "BFL00001.BBL", 1);
    const texts = [...SD_DATA_ERROR_TEXTS, "flux capacitor desync (code 7)"];
    for (const t of texts) {
      const line = `sd_data_error: ${t}`;
      r.fw.addFault(lba, { type: /^(guard check failed|driver error)$/.test(t) ? "async" : "immediate", line });
      const m = r.mark();
      click("Download BFL00001.BBL");
      await expectMessage(new RegExp(`^The flight controller stopped the read of sector ${lba}\\. Nothing was saved\\. Sent sd cancel\\.$`));
      assert.equal(shown("bb-download-fw-line"), line, `verbatim and visible: ${line}`);
      assert.ok(pageText().includes(`Controller reply: ${line}`), `rendered as visible text: ${line}`);
      assert.equal(byTestId("bb-download-result")?.getAttribute("role"), "alert");
      assert.equal(savedFiles().length, 0, `nothing saved after ${t}`);
      const sd = r.sdSince(m);
      assert.equal(sd[0], "sd probe");
      assert.deepEqual(sd.slice(-2), [`sd read ${lba}`, "sd cancel"], `stopped at the failing sector: ${t}`);
    }
    await r.done();
  });

  await test("FW guard: arming mid-read gives `guard check failed` verbatim; nothing saved", async () => {
    const r = await rig();
    await listCard(r);
    const target = dataLba(r, "BFL00001.BBL", 10);
    r.fw.onReadBegin = (s) => { if (s === target) r.fw.setArmed(true); };
    click("Download BFL00001.BBL");
    await expectMessage(/stopped the read of sector/);
    assert.equal(shown("bb-download-fw-line"), "sd_data_error: guard check failed");
    assert.equal(savedFiles().length, 0);
    await r.done();
  });

  await test("stale probe: a `done` probe from before a recording is never trusted; list and download always re-probe", async () => {
    const r = await rig({ initialPhase: "done", stale: true });
    let m = r.mark();
    await listCard(r);
    assert.equal(r.sdSince(m)[0], "sd probe");
    r.fw.recordingCycle(); // a recording between list and download: the old probe still says done
    m = r.mark();
    click("Download BFL00002.BBL");
    await expectMessage(/^Saved BFL00002\.BBL: 700 bytes, 2 sectors CRC-verified\./);
    assert.equal(r.sdSince(m)[0], "sd probe");
    assert.ok(!pageText().includes("driver error"));
    assert.deepEqual(Buffer.from(await savedBytes()), Buffer.from(r.card.payload("BFL00002.BBL")));
    await r.done();
  });

  await test("probe refusals verbatim: recording owns the card, armed, host simulation; no sd read is sent", async () => {
    const cases: Array<[MockSdFirmwareOptions, string]> = [
      [{ recorderOwnsCard: true }, SD_PROBE_REFUSALS[0]],
      [{ armed: true }, SD_PROBE_REFUSALS[1]],
      [{ hostSimulation: true }, "sd unavailable: no hardware backend in host simulation"],
    ];
    for (const [opts, line] of cases) {
      const r = await rig(opts); // FC still reports idle + disarmed: only the FW lock refuses (race)
      click("Probe card and list logs");
      await expectMessage(/^The flight controller refused sd probe\. Nothing was saved\./);
      assert.equal(shown("bb-download-fw-line"), line, "refusal shown verbatim");
      assert.ok(pageText().includes(line));
      assert.ok(!r.fw.log.some((l) => l.startsWith("sd read")), "no sd read after a refused probe");
      assert.equal(fileRows().length, 0);
      await r.done();
    }
  });

  await test("UI locks: Download/List disabled while recording, armed, post-flash, SD check busy or disconnected (reason shown)", async () => {
    let r = await rig({ blackboxStatus: RECORDING_STATUS });
    assert.ok(await waitFor(() => /Onboard recording owns the SD card/.test(shown("bb-download-blocked") ?? "")), `recording lock: ${shown("bb-download-blocked")}`);
    assert.ok(isDisabled(button("Probe card and list logs")));
    await r.done();

    r = await rig();
    await listCard(r);
    r.fw.statusLines = ["arm: armed", "loop_overruns: 3"];
    assert.ok(await waitFor(() => /Disarm before downloading/.test(shown("bb-download-blocked") ?? ""), 5000), `armed lock: ${shown("bb-download-blocked")}`);
    assert.ok(isDisabled(button("Probe card and list logs")) && isDisabled(button("Download BFL00001.BBL")));
    r.fw.statusLines = ["arm: disarmed", "loop_overruns: 3"];
    assert.ok(await waitFor(() => shown("bb-download-blocked") === null, 5000));
    r.ctx.postFlashGate = true; r.rerender();
    assert.match(shown("bb-download-blocked") ?? "", /post-flash/);
    assert.ok(isDisabled(button("Download BFL00001.BBL")));
    r.ctx.postFlashGate = false; r.rerender();
    click("Check SD card"); // SD diagnostic probe owns the link until its status poll says done
    assert.ok(await waitFor(() => /Finish the SD card check/.test(shown("bb-download-blocked") ?? ""), 2000), `storage lock: ${shown("bb-download-blocked")}`);
    assert.ok(isDisabled(button("Probe card and list logs")));
    await r.client.disconnect();
    assert.ok(await waitFor(() => /Connect to the controller/.test(shown("bb-download-blocked") ?? "")));
    assert.ok(isDisabled(button("Probe card and list logs")));
    await r.done();
  });

  await test("timeout: no reply to a sector aborts naming it; nothing saved; no further reads", async () => {
    const r = await rig({}, 300);
    await listCard(r);
    const lba = dataLba(r, "BFL00001.BBL", 5);
    r.fw.addFault(lba, { type: "silent" });
    const m = r.mark();
    click("Download BFL00001.BBL");
    await expectMessage(new RegExp(`^No reply to sd read ${lba} within 0\\.3 s\\. Nothing was saved\\.`));
    assert.equal(savedFiles().length, 0);
    assert.equal(r.fw.log.slice(m).filter((l) => l.startsWith("sd read")).at(-1), `sd read ${lba}`);
    // Existing client policy: a framed reply that never terminates drops the link (late bytes are never misattributed).
    assert.equal(r.client.getConnectionStatus(), "disconnected");
    assert.match(shown("bb-download-message") ?? "", /sd cancel was not sent \(not connected\)\./);
    await r.done();
  });

  await test("Cancel sends sd cancel after the in-flight reply, discards partial data, no further reads", async () => {
    const r = await rig({ readDelayMs: 3 });
    await listCard(r);
    const target = dataLba(r, "BFL00001.BBL", 10);
    r.fw.onReadBegin = (s) => { if (s === target) setTimeout(() => click("Cancel download"), 0); };
    const m = r.mark();
    click("Download BFL00001.BBL");
    await expectMessage(/^Download cancelled\. Partial data was discarded\. Sent sd cancel\.$/);
    assert.equal(savedFiles().length, 0);
    const sd = r.sdSince(m);
    assert.deepEqual(sd.slice(-2), [`sd read ${target}`, "sd cancel"]);
    assert.equal(shown("bb-download-progress"), null);
    // Cancel while the probe is still running.
    r.fw.probeMs = Infinity;
    const m2 = r.mark();
    click("Probe card and list logs");
    assert.ok(await waitFor(() => r.sdSince(m2).includes("sd status")));
    click("Cancel download");
    await expectMessage(/^Listing cancelled\. Partial data was discarded\. Sent sd cancel\.$/);
    assert.equal(r.sdSince(m2).at(-1), "sd cancel");
    assert.equal(r.fw.phase, "cancelled");
    await r.done();
  });

  await test("disconnect mid-read: abort, nothing saved, nothing sent after the unplug", async () => {
    const r = await rig();
    await listCard(r);
    const target = dataLba(r, "BFL00001.BBL", 10);
    let at = -1;
    r.fw.onReadBegin = (s) => { if (s === target) { at = r.fw.log.length; r.factory.port!.unplug(); } };
    click("Download BFL00001.BBL");
    await expectMessage(/^Download stopped: the USB connection closed\. Partial data was discarded\. sd cancel was not sent \(not connected\)\.$/);
    assert.equal(savedFiles().length, 0);
    assert.equal(r.fw.log.length, at, "no command after the unplug");
    assert.equal(r.client.getConnectionStatus(), "disconnected");
    await r.done();
  });

  await test("leaving the tab mid-download: sd cancel sent, nothing saved, reason shown on return", async () => {
    const r = await rig({ readDelayMs: 2 });
    await listCard(r);
    const target = dataLba(r, "BFL00001.BBL", 10);
    r.fw.onReadBegin = (s) => { if (s === target) setTimeout(() => r.setVisible(false), 0); };
    const m = r.mark();
    click("Download BFL00001.BBL");
    assert.ok(await waitFor(() => r.sdSince(m).at(-1) === "sd cancel"), `sd cancel after tab leave: ${r.sdSince(m).slice(-3)}`);
    await sleep(30);
    assert.equal(shown("bb-download-message"), null, "hidden tab shows nothing");
    r.setVisible(true);
    await expectMessage(/^Download stopped because you left the Blackbox tab\. Partial data was discarded\. Sent sd cancel\.$/);
    assert.equal(savedFiles().length, 0);
    await r.done();
  });

  await test("not ready: done without sd_sectors, or sd_io_error not 0, aborts before any sd read", async () => {
    for (const [opts, re] of [[{ omitSectors: true }, /sd_sectors missing/], [{ sdIoError: 5 }, /sd_io_error: 5/]] as const) {
      const r = await rig(opts);
      click("Probe card and list logs");
      await expectMessage(re);
      assert.ok(!r.fw.log.some((l) => l.startsWith("sd read")));
      assert.equal(r.sdSince(0).at(-1), "sd cancel");
      await r.done();
    }
  });

  await test("verbatim counters: loop_overruns from status; when the card cannot show the reply, all recorder fields verbatim, unknown tokens as-is, missing = unknown", async () => {
    let r = await rig();
    assert.ok(await waitFor(() => counterRows().length === 1));
    assert.deepEqual(counterRows(), [["loop_overruns", "12"]], "card fields are not duplicated; only the gap is filled");
    await r.done();
    const odd = "blackbox_api: 2\r\nblackbox_state: done\r\nblackbox_reason: stopped\r\nblackbox_file: BFL00001.BBL\r\nblackbox_bytes: 40116\r\nblackbox_frames: 0650\r\nblackbox_rate_hz: 2000\r\nblackbox_dropped: 3731\r\nblackbox_missed: 0\r\nblackbox_invalid: 0\r\nblackbox_active: 0\r\nblackbox_rate_requested_hz: 2000\r\nblackbox_rate_reason: Auto-Lowered-CPU\r\nblackbox_drop_pct: 85.2\r\nblackbox_end: 1\r\n";
    r = await rig({ blackboxStatus: odd, statusLines: ["arm: disarmed", "loop_overruns: n/a"] });
    assert.ok(await waitFor(() => counterRows().length === 10), `rows: ${JSON.stringify(counterRows())}`);
    assert.deepEqual(counterRows(), [
      ["blackbox_frames", "0650"], ["blackbox_dropped", "3731"], ["blackbox_missed", "0"], ["blackbox_invalid", "0"],
      ["blackbox_queue", "unknown"], ["blackbox_drop_pct", "85.2"], ["blackbox_rate_hz", "2000"],
      ["blackbox_rate_requested_hz", "2000"], ["blackbox_rate_reason", "Auto-Lowered-CPU"], ["loop_overruns", "n/a"],
    ]);
    assert.ok(pageText().includes("blackbox_rate_reasonAuto-Lowered-CPU"), "visible");
    await r.done();
  });

  await test("controller: 15 s probe cap by default; a probe that never completes aborts with sd cancel", async () => {
    const fw = new MockSdCliFirmware({ card: new SparseFat32Card(), probeMs: Infinity });
    const client = new BobFlightCliClient(new SdSimTransportFactory(fw));
    await client.connect({ path: "sim://bobflight-sd", transport: "serial" });
    await sleep(5);
    const gate = new CommandGate(() => 1);
    const link = {
      getConnectionStatus: () => client.getConnectionStatus(),
      sendCommand: (cmd: "sd probe" | "sd status" | "sd cancel") => gate.run(() => client.sendCommand(cmd)),
      readSdSector: (s: number) => new SdSectorReader(gate, (cmd, o) => client.sendCommand(cmd, o)).read(s),
    };
    const saved: string[] = [];
    assert.equal((new SdDownloadController(link, { save: () => {} }) as unknown as { probeTimeoutMs: number }).probeTimeoutMs, SD_PROBE_TIMEOUT_MS);
    assert.equal(SD_PROBE_TIMEOUT_MS, 15000);
    const c = new SdDownloadController(link, { save: (n) => saved.push(n), probeTimeoutMs: 250, pollIntervalMs: 20 });
    assert.equal(await c.list(), false);
    assert.match(c.message?.text ?? "", /^The card did not reach sd_state: done within 0\.25 s of the probe\. Nothing was saved\. Sent sd cancel\.$/);
    assert.equal(fw.sdCommands().at(-1), "sd cancel");
    assert.ok(!fw.log.some((l) => l.startsWith("sd read")));
    assert.equal(saved.length, 0);
    await client.disconnect();
  });

  console.log(`PASS Blackbox SD download render: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 180000);
main().then(() => { clearTimeout(guard); process.exit(0); }).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); });
