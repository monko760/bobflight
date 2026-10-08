/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { FlasherPage } from "../src/pages/FlasherPage";
import { validateFirmwareForBoard } from "../src/flasher/firmwareValidation";
import { parseIntelHex } from "../src/flasher/intelHex";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// ---- DOM Helpers ----
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTag = (tag: string) => container.findAll((e) => e.tagName === tag);
function inputById(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `input #${id}`);
  return el;
}
function selectById(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "SELECT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `select #${id}`);
  return el;
}
function buttonByText(text: string): FakeElement {
  const b = byTag("BUTTON").find((e) => visibleText(e).startsWith(text));
  assert.ok(b, `button ${text}`);
  return b;
}
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");

function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
async function check(el: FakeElement, checked: boolean) {
  flushSync(() => reactProps(el).onChange({ target: { checked }, currentTarget: { checked } }));
  await sleep(10);
}
async function selectOption(el: FakeElement, value: string) {
  flushSync(() => reactProps(el).onChange({ target: { value }, currentTarget: { value } }));
  await sleep(10);
}
async function click(el: FakeElement) {
  flushSync(() => reactProps(el).onClick({}));
  await sleep(10);
}

// Sample valid F722 hex string (small 16-byte record)
function record(bytes: number[]) { return ':'+[...bytes,(-bytes.reduce((a,b)=>a+b,0))&255].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase(); }
const F722_HEX = [record([2,0,0,4,8,0]),record([16,0,0,0,0,0,1,32,9,0,0,8,1,2,3,4,5,6,7,8]),record([0,0,0,1])].join('\n');

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

async function main() {
  // ---- 1. Unit Tests for firmwareValidation ----
  await test("validateFirmwareForBoard: missing board or hex", async () => {
    const parsed = parseIntelHex(F722_HEX, { mcuHint: "F722" });
    assert.ok(validateFirmwareForBoard(null, "tmotor_f7_v2", "tmotor.hex") !== null);
    assert.ok(validateFirmwareForBoard(parsed, "", "tmotor.hex") !== null);
  });

  await test("validateFirmwareForBoard: MCU mismatch detection", async () => {
    const parsedF745 = parseIntelHex(F722_HEX, { mcuHint: "F745" });
    const err = validateFirmwareForBoard(parsedF745, "tmotor_f7_v2", "firmware.hex");
    assert.ok(err !== null && err.includes("MCU"));
  });

  await test("validateFirmwareForBoard: valid hex and matching board", async () => {
    const parsedF745 = parseIntelHex(F722_HEX, { mcuHint: "F722" });
    const err = validateFirmwareForBoard(parsedF745, "tmotor_f7_v2", "bobflight.hex");
    assert.equal(err, null);
  });

  // ---- 2. FlasherPage Component Integration Tests ----
  await test("FlasherPage render: contains 7 numbered stages and safety controls", async () => {
    let gated = false;
    (globalThis as Record<string, unknown>).__setupTestHost = {
      connectionStatus: "disconnected",
      setPostFlashGate: (g: boolean) => { gated = g; },
      clearPostFlashGateAfterReconnect: () => { gated = false; },
    };

    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<FlasherPage />));

    const pageText = visibleText(container);
    assert.ok(pageText.includes("Stage 1: Safety, Backup & Recovery Setup"));
    assert.ok(pageText.includes("Stage 2: Select Target Board"));
    assert.ok(pageText.includes("Stage 3: Build or Load Firmware"));
    assert.ok(pageText.includes("Stage 4: Enter DFU Mode & Disconnect CDC"));
    assert.ok(pageText.includes("Stage 5: Select & Confirm DFU Device"));
    assert.ok(pageText.includes("Stage 6: Execute Flash"));
    assert.ok(pageText.includes("Stage 7: Reconnect & Restore Configuration"));

    // Initial Flash button should be disabled
    const flashBtn = buttonByText("Flash");
    assert.ok(isDisabled(flashBtn));

    root.unmount();
  });

  await test("FlasherPage demo mode: explicit opt-in enables mock flash when safety items checked", async () => {
    (globalThis as Record<string, unknown>).__setupTestHost = {
      connectionStatus: "disconnected",
      setPostFlashGate: () => {},
      clearPostFlashGateAfterReconnect: () => {},
    };

    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<FlasherPage />));

    // Check Stage 1 checkboxes
    await check(inputById("props-off"), true);
    await check(inputById("backup-taken"), true);

    // Select Stage 2 target
    await selectOption(selectById("board"), "tmotor_f7_v2");

    // Enable Demo mode (Stage 5)
    await check(inputById("use-mock-flash"), true);
    await check(inputById("mock-understood"), true);

    // Simulate file input change on Stage 3
    const fileInput = inputById("hex-file");
    const file = { name: "bobflight.hex", size: F722_HEX.length, text: async () => F722_HEX };
    flushSync(() => reactProps(fileInput).onChange({ target: { files: [file] }, currentTarget: { files: [file] } }));
    await sleep(20);

    // Flash button should now be enabled for demo
    const flashBtn = buttonByText("Flash");
    assert.equal(isDisabled(flashBtn), false);

    // Execute mock flash
    await click(flashBtn);
    assert.ok(await waitFor(() => visibleText(container).includes("MOCK ONLY"), 3000));

    root.unmount();
  });

  await test("FlasherPage live mode: blocked when CDC is connected", async () => {
    (globalThis as Record<string, unknown>).__setupTestHost = {
      connectionStatus: "connected",
      setPostFlashGate: () => {},
      clearPostFlashGateAfterReconnect: () => {},
    };

    const root: Root = createRoot(container as never);
    flushSync(() => root.render(<FlasherPage />));

    const pageText = visibleText(container);
    assert.ok(pageText.includes("Disconnect Configurator CDC before flashing in DFU mode"));

    const flashBtn = buttonByText("Flash");
    assert.ok(isDisabled(flashBtn));

    root.unmount();
  });

  await test("Build HEX feeds the importer, locks selection, never flashes and clears old images on failure", async () => {
    (globalThis as Record<string, unknown>).__setupTestHost = {connectionStatus:"disconnected",setPostFlashGate:()=>{},clearPostFlashGateAfterReconnect:()=>{}};
    if (!globalThis.crypto) Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
    const oldFile=globalThis.File, oldFetch=globalThis.fetch;
    (globalThis as unknown as {File:unknown}).File=NodeFile;
    let requests=0, finish: (value:unknown)=>void = ()=>{};
    globalThis.fetch=(async (_url:unknown, init?:RequestInit) => {
      if(init?.method==="GET")return {ok:true,json:async()=>({protocol:1,token:"fixture"})};
      requests++; return await new Promise(resolve=>{finish=resolve;});
    }) as typeof fetch;
    const states:boolean[]=[];
    const root=createRoot(container as never);
    try {
      flushSync(()=>root.render(<FlasherPage onBusyChange={v=>states.push(v)}/>));
      await selectOption(selectById("board"),"tmotor_f7_v2");
      assert.equal(requests,0,"selection must not start a build");
      await click(buttonByText("Build HEX"));
      assert.equal(requests,1);
      assert.ok(isDisabled(selectById("board")));
      assert.ok(isDisabled(inputById("hex-file")));
      assert.ok(isDisabled(buttonByText("Flash")));
      // Directly invoke the same handler to model two queued clicks.
      await click(buttonByText("Building HEX"));assert.equal(requests,1);
      finish({ok:true,json:async()=>({fileName:"bobflight-tmotor_f7_v2-main.hex",hex:F722_HEX,sha256:createHash("sha256").update(F722_HEX).digest("hex"),sourceRevision:"a".repeat(40),profile:"main",boardId:"tmotor_f7_v2"})});
      assert.ok(await waitFor(()=>visibleText(container).includes("Selected: bobflight-tmotor_f7_v2-main.hex")));
      assert.ok(await waitFor(()=>!isDisabled(selectById("board"))));
      assert.ok(isDisabled(buttonByText("Flash")),"build cannot bypass flash safety controls");
      assert.deepEqual(states,[true,false]);
      await click(buttonByText("Build HEX"));
      assert.ok(!visibleText(container).includes("Selected: bobflight-tmotor_f7_v2-main.hex"));
      finish({ok:false,json:async()=>({error:"Compiler unavailable"})});
      assert.ok(await waitFor(()=>visibleText(container).includes("Compiler unavailable")));
      assert.ok(isDisabled(buttonByText("Flash")));
      assert.deepEqual(states,[true,false,true,false]);
    } finally {flushSync(()=>root.unmount());globalThis.fetch=oldFetch;globalThis.File=oldFile;}
  });

  console.log(`\nAll ${passed} Flasher Journey tests passed successfully!`);
}

main().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
