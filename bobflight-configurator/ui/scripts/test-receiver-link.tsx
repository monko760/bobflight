/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * CRSF link statistics readout (FW: receiver report rx_link_stats / rx_link_lq /
 * rx_loss_reason). Two layers, no source regex:
 *  1. renderToStaticMarkup of ReceiverLinkReadout for every mock scenario, reading
 *     the VISIBLE text of each cell (elements with the `hidden` attribute are skipped).
 *  2. The real ReceiverPage in the fakeDom harness, polling a MockBobFlightHost:
 *     cells follow each new `receiver` reply, and the link state never feeds the
 *     StoragePanel `blocked` prop.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { RECEIVER_LINK_SCENARIOS, MockReceiver, type ReceiverLinkMockScenario } from "@bobflight/protocol";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { ReceiverLinkReadout } from "../src/components/ReceiverLinkReadout";
import { ReceiverPage } from "../src/pages/ReceiverPage";
import { parseReceiver, receiverLinkView } from "../src/protocol/receiver";
import { MockBobFlightHost } from "../src/protocol/mockHost";
import { parseStatus, shouldDisableArm } from "../src/protocol/parseStatus";
import type { CliCommand } from "../src/protocol/types";

type Row = [string, string, string];
/** Expected visible cells (rx_link_stats, rx_link_lq, rx_loss_reason) per mock scenario. */
const EXPECTED: Record<ReceiverLinkMockScenario, Row> = {
  "default": ["absent", "unavailable", "no-frames"],
  "present-ok": ["present", "87", "none"],
  "absent": ["absent", "unavailable", "none"],
  "lq-zero": ["present", "0", "lq-zero"],
  "rf-mode-low": ["present", "64", "rf-mode-low"],
  "stats-stale": ["present", "unavailable", "stats-stale"],
  "no-frames": ["present", "unavailable", "no-frames"],
  "unknown-token": ["partial", "unknown", "rf-jammed"],
  "old-fc": ["unknown", "unknown", "unknown"],
};
const KEYS = ["rx_link_stats", "rx_link_lq", "rx_loss_reason"] as const;

/** Visible text of every `data-rx-link` cell in static markup; text under a `hidden` element is dropped. */
function staticCells(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: { tag: string; hidden: boolean; key?: string }[] = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[5] !== undefined) {
      const key = [...stack].reverse().find((f) => f.key)?.key;
      if (key && !stack.some((f) => f.hidden)) out[key] = (out[key] ?? "") + m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
      continue;
    }
    if (m[1]) { stack.pop(); continue; }
    const attrs = m[3];
    const frame = { tag: m[2], hidden: /(^|\s)hidden(=|\s|$)/.test(attrs), key: /data-rx-link="([a-z_]+)"/.exec(attrs)?.[1] };
    if (frame.key && out[frame.key] === undefined) out[frame.key] = "";
    if (!m[4]) stack.push(frame);
  }
  return out;
}

const { container } = installFakeDom();
function visibleText(n: FakeElement): string {
  if (n.hasAttribute("hidden")) return "";
  return n.childNodes.map((c) => (c.nodeType === 3 ? (c as unknown as { nodeValue: string }).nodeValue : visibleText(c as FakeElement))).join("");
}
function pageCells(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of container.findAll((e) => e.getAttribute("data-rx-link") !== null)) out[el.getAttribute("data-rx-link")!] = visibleText(el);
  return out;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); } catch (e) { console.log(`FAIL ${name}`); throw e; }
  passed++; console.log(`PASS ${name}`);
}

async function main() {
  await test("every mock scenario is covered", () => {
    assert.deepEqual([...RECEIVER_LINK_SCENARIOS].sort(), Object.keys(EXPECTED).sort());
  });
  for (const sc of RECEIVER_LINK_SCENARIOS) {
    await test(`renderToStaticMarkup ${sc}: visible cells verbatim`, () => {
      const reading = parseReceiver(new MockReceiver(sc).handle("receiver", false, false)!);
      const cells = staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={reading} />));
      assert.deepEqual(KEYS.map((k) => cells[k]), EXPECTED[sc], `${sc}: visible cells`);
    });
  }
  await test("no reply yet: every cell shows unknown", () => {
    const cells = staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={null} />));
    assert.deepEqual(KEYS.map((k) => cells[k]), ["unknown", "unknown", "unknown"]);
  });
  await test("rx_link_lq: only an integer 0..100 or `unavailable` is shown; anything else is unknown (no math)", () => {
    const base = new MockReceiver("present-ok").handle("receiver", false, false)!;
    const cases: [string, string][] = [["0", "0"], ["7", "7"], ["99", "99"], ["100", "100"], ["unavailable", "unavailable"],
      ["101", "unknown"], ["-1", "unknown"], ["07", "unknown"], ["87%", "unknown"], ["8.5", "unknown"], ["1e2", "unknown"], ["Unavailable", "unknown"], ["4294967296", "unknown"]];
    for (const [wire, shown] of cases) {
      const r = parseReceiver(base.replace("rx_link_lq: 87", `rx_link_lq: ${wire}`));
      assert.equal(r.rx_link_lq, wire, "parser keeps the FC string verbatim");
      assert.equal(staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={r} />)).rx_link_lq, shown, `lq ${wire}`);
    }
    assert.equal(receiverLinkView(parseReceiver(base.replace("rx_link_lq: 87\r\n", ""))).rx_link_lq, "unknown", "missing key");
  });
  await test("future tokens and a single missing key", () => {
    const base = new MockReceiver("present-ok").handle("receiver", false, false)!;
    const r = parseReceiver(base.replace("rx_link_stats: present", "rx_link_stats: degraded-v2").replace("rx_loss_reason: none", "rx_loss_reason: lq-low"));
    assert.deepEqual(KEYS.map((k) => staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={r} />))[k]), ["degraded-v2", "87", "lq-low"]);
    const missing = parseReceiver(base.replace("rx_loss_reason: none\r\n", ""));
    assert.deepEqual(KEYS.map((k) => staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={missing} />))[k]), ["present", "87", "unknown"]);
  });

  await test("rx_loss_reason is rendered verbatim with no token allowlist: every FW token (read from rx.c) and unknown ones", () => {
    const rxC = readFileSync(new URL("../../../bobflight-firmware/src/drivers/rx.c", import.meta.url), "utf8");
    const fwTokens = [...rxC.matchAll(/case RX_LOSS_[A-Z_]+: return "([a-z-]+)";/g)].map((m) => m[1]);
    assert.deepEqual([...fwTokens].sort(), ["lq-zero", "no-frames", "none", "rf-mode-low", "stats-stale"], "FW rx_loss_reason tokens");
    const base = new MockReceiver("present-ok").handle("receiver", false, false)!;
    for (const tok of [...fwTokens, "rf-mode-lower", "rf_mode_low", "RF-MODE-LOW", "mode-7"]) {
      const r = parseReceiver(base.replace("rx_loss_reason: none", `rx_loss_reason: ${tok}`));
      assert.equal(r.rx_loss_reason, tok, "parser keeps the token verbatim");
      assert.equal(staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={r} />)).rx_loss_reason, tok, `${tok} rendered verbatim`);
    }
  });
  for (const sc of RECEIVER_LINK_SCENARIOS) {
    await test(`Arm gate follows the FC failsafe for ${sc} (status failsafe ACTIVE <=> receiver failsafe 1)`, async () => {
      const m = new MockBobFlightHost({ connectDelayMs: 0, gyroHealthy: true, receiverLinkScenario: sc });
      await m.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
      const rx = parseReceiver(String(await m.sendCommand("receiver" as CliCommand)));
      const st = parseStatus(String(await m.sendCommand("status" as CliCommand)));
      const lost = rx.failsafe === 1;
      assert.equal(st.failsafe, lost ? "ACTIVE" : "ok", `${sc}: status failsafe`);
      assert.equal(shouldDisableArm(st), lost, `${sc}: Arm ${lost ? "blocked" : "open"}`);
      if (lost) assert.ok(st.failClosedReasons.includes("failsafe:ACTIVE"), `${sc}: fail-closed reason failsafe:ACTIVE`);
      const armReply = String(await m.sendCommand("arm" as CliCommand));
      assert.equal(/^armed/.test(armReply), !lost, `${sc}: mock arm ${lost ? "refused" : "accepted"}: ${armReply}`);
      if (sc === "rf-mode-low") {
        assert.equal(lost, true, "rf-mode-low is a loss: failsafe 1");
        assert.deepEqual(KEYS.map((k) => staticCells(renderToStaticMarkup(<ReceiverLinkReadout reading={rx} />))[k]), ["present", "64", "rf-mode-low"]);
      }
      if (["lq-zero", "rf-mode-low", "stats-stale", "no-frames"].includes(sc)) assert.equal(lost, true, `${sc}: every loss reason blocks Arm`);
      await m.disconnect();
    });
  }

  // ---- real ReceiverPage in the fakeDom harness ----
  const mock = new MockBobFlightHost({ connectDelayMs: 0, receiverLinkScenario: "present-ok" });
  await mock.connect({ path: "mock://bobflight", baudRate: 115200 } as never);
  const sent: string[] = [];
  const host = {
    getConnectionStatus: () => mock.getConnectionStatus(),
    sendCommand: (cmd: CliCommand) => { sent.push(cmd); return mock.sendCommand(cmd); },
    saveSettings: () => mock.saveSettings(), restoreDefaults: () => mock.restoreDefaults(),
  };
  (globalThis as Record<string, unknown>).__setupTestHost = {
    host, connectionStatus: "disconnected", version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {}, postFlashGate: false,
  };
  const root: Root = createRoot(container as never);
  flushSync(() => root.render(<ReceiverPage />));
  const protocolSelect = () => {
    const nodes = container.findAll(e => e.getAttribute("id") === "receiver-protocol");
    assert.equal(nodes.length, 1, "one receiver protocol selector");
    return nodes[0];
  };
  const disabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
  const context = (globalThis as Record<string, unknown>).__setupTestHost as Record<string, unknown>;
  await test("protocol selector offers only CRSF and stays disabled while disconnected", () => {
    const select = protocolSelect();
    assert.equal(select.tagName, "SELECT");
    assert.deepEqual(select.options.map(o => [o.value, o.textContent]), [["CRSF", "CRSF"]]);
    assert.ok(select.options[0].selected);
    assert.ok(disabled(select));
    assert.ok(container.textContent.includes("fixed in firmware"));
    assert.equal(sent.length, 0, "disconnected selector sends no commands");
  });
  context.connectionStatus = "connected";
  flushSync(() => root.render(<ReceiverPage />));
  const blockedNote = () => container.textContent.includes("Apply all edits on this page before saving");
  const order: ReceiverLinkMockScenario[] = ["present-ok", "lq-zero", "rf-mode-low", "stats-stale", "no-frames", "absent", "unknown-token", "old-fc", "present-ok"];
  for (const sc of order) {
    await test(`ReceiverPage follows each new receiver reply: ${sc}`, async () => {
      mock.setMockGates({ receiverLinkScenario: sc });
      const polls = sent.filter((c) => c === "receiver").length;
      const ok = await waitFor(() => sent.filter((c) => c === "receiver").length >= polls + 2 && JSON.stringify(KEYS.map((k) => pageCells()[k])) === JSON.stringify(EXPECTED[sc]), 3000);
      assert.ok(ok, `${sc}: page cells ${JSON.stringify(pageCells())}, expected ${JSON.stringify(EXPECTED[sc])}`);
      if (sc !== "old-fc") assert.equal(blockedNote(), false, `${sc}: link state must not feed StoragePanel blocked`);
    });
  }
  await test("valid diagnostics enable CRSF without a new Apply/Save or protocol command", () => {
    const select = protocolSelect();
    assert.ok(!disabled(select));
    assert.deepEqual(select.options.map(o => o.value), ["CRSF"]);
    const key = Object.keys(select).find(k => k.startsWith("__reactProps$"));
    assert.ok(key, "React event props available");
    const props = (select as unknown as Record<string, {onChange: (e: unknown) => void}>)[key!];
    const before = [...sent];
    props.onChange({currentTarget: {value: "CRSF"}});
    assert.deepEqual(sent, before, "selecting CRSF does not mutate or save board state");
  });
  await test("missing receiver diagnostics disable protocol selection", async () => {
    const goodSend = host.sendCommand;
    host.sendCommand = (cmd: CliCommand) => cmd === "receiver"
      ? Promise.resolve("unknown command: receiver") : goodSend(cmd);
    assert.ok(await waitFor(() => disabled(protocolSelect()) && container.textContent.includes("No current receiver diagnostics."), 2000));
    host.sendCommand = goodSend;
  });
  await test("post-flash gate and disconnect disable the protocol selector", () => {
    context.postFlashGate = true;
    flushSync(() => root.render(<ReceiverPage />));
    assert.ok(disabled(protocolSelect()));
    context.postFlashGate = false; context.connectionStatus = "disconnected";
    flushSync(() => root.render(<ReceiverPage />));
    assert.ok(disabled(protocolSelect()));
  });
  root.unmount(); await mock.disconnect();
  console.log(`PASS receiver link statistics readout: ${passed} tests`);
}
const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); }); // exit: a failed render test can leave pollers running
