/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { HexBuilder, isBoardSupported } from "../src/flasher/HexBuilder";
import crypto from "node:crypto";

if (!globalThis.crypto) {
  (globalThis as any).crypto = crypto.webcrypto;
}

if (!globalThis.File) {
  (globalThis as any).File = class File {
    constructor(public bits: any[], public name: string, public options?: any) {}
  };
}
if (!globalThis.Blob) {
  (globalThis as any).Blob = class Blob {
    constructor(public bits: any[], public options?: any) {}
  };
}
if (!globalThis.URL) {
  (globalThis as any).URL = {
    createObjectURL: () => "blob:mock-url",
    revokeObjectURL: () => {},
  };
} else if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:mock-url";
  globalThis.URL.revokeObjectURL = () => {};
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");

function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}

async function click(el: FakeElement) {
  flushSync(() => reactProps(el).onClick({}));
  await sleep(10);
}

async function computeSha256Node(text: string): Promise<string> {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function runTests() {
  console.log("Starting HexBuilder test suite...");

  // 1. Test isBoardSupported logic
  console.log("Test 1: Target board support rules (isBoardSupported)");
  {
    // Empty boardId
    const emptyCheck = isBoardSupported("", "", "", "");
    assert.equal(emptyCheck.supported, false);
    assert.match(emptyCheck.reason || "", /Select a board/);

    // Custom F405 - incomplete/invalid params
    const customInvalidMcu = isBoardSupported("custom_f405xg_usb", "STM32F411", "1024", "8000000");
    assert.equal(customInvalidMcu.supported, false);
    assert.equal(customInvalidMcu.isF405Diagnostic, true);
    assert.match(customInvalidMcu.reason || "", /Custom basic build is only supported for STM32F405/);

    const customInvalidFlash = isBoardSupported("custom_f405xg_usb", "STM32F405", "512", "8000000");
    assert.equal(customInvalidFlash.supported, false);

    const customInvalidHse = isBoardSupported("custom_f405xg_usb", "STM32F405", "1024", "12000000");
    assert.equal(customInvalidHse.supported, false);

    // Custom F405 - valid basic params
    const customValid = isBoardSupported("custom_f405xg_usb", "STM32F405", "1024", "8000000");
    assert.equal(customValid.supported, true);
    assert.equal(customValid.isF405Diagnostic, true);

    // mltempf4 (Motolab Tempest F4 USB diagnostic)
    const mltempf4Check = isBoardSupported("mltempf4", "", "", "");
    assert.equal(mltempf4Check.supported, true);
    assert.equal(mltempf4Check.isF405Diagnostic, true);

    // Known F7 target (kakute_f7_hdv or tmotor_f7_v2)
    const f7Check = isBoardSupported("kakute_f7_hdv", "", "", "");
    assert.equal(f7Check.supported, true);
    assert.equal(f7Check.isF405Diagnostic, false);

    // Unknown target
    const unknownCheck = isBoardSupported("unknown_board_999", "", "", "");
    assert.equal(unknownCheck.supported, false);
    assert.match(unknownCheck.reason || "", /Build not supported/);
  }

  // 2. React UI Mounting & Diagnostic Label Rendering
  console.log("Test 2: React component DOM rendering and labels");
  {
    const { container } = installFakeDom();
    const root = createRoot(container as never);

    let busyCalls: boolean[] = [];

    // Render with mltempf4 (F405 diagnostic)
    flushSync(() => {
      root.render(
        <HexBuilder
          boardId="mltempf4"
          customMcu=""
          customFlash=""
          customHse=""
          disabled={false}
          onLoad={async () => {}}
          onBusyChange={(b) => busyCalls.push(b)}
        />
      );
    });

    const buttons = container.findAll((e) => e.tagName === "BUTTON");
    const buildBtn = buttons.find((b) => b.getAttribute("class") === "btn-build-hex");
    assert.ok(buildBtn, "Build HEX button should exist");
    assert.equal(isDisabled(buildBtn!), false);

    const labels = container.findAll((e) => e.getAttribute("class") === "hex-builder-label");
    assert.equal(labels.length, 1);
    assert.match(labels[0].textContent, /F405 USB diagnostic build profile/);

    // Render with unsupported custom profile
    flushSync(() => {
      root.render(
        <HexBuilder
          boardId="custom_f405xg_usb"
          customMcu="STM32F411"
          customFlash="512"
          customHse="8000000"
          disabled={false}
          onLoad={async () => {}}
          onBusyChange={(b) => busyCalls.push(b)}
        />
      );
    });

    const disabledBtn = container.findAll((e) => e.tagName === "BUTTON")[0];
    assert.equal(isDisabled(disabledBtn), true);

    const warnings = container.findAll((e) => e.getAttribute("class") === "hex-builder-warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].textContent, /Custom basic build is only supported for STM32F405/);
    flushSync(() => root.unmount());
  }

  // 3. Successful Build Request Flow (GET + POST)
  console.log("Test 3: Successful build flow with SHA256 verification");
  {
    const { container } = installFakeDom();
    const root = createRoot(container as never);

    const testHex = ":100000002000042000000000000000000000000030\n:00000001FF";
    const testSha = await computeSha256Node(testHex);

    let loadedFile: any = null;
    let busyStates: boolean[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (url === "/__bobflight_build" && init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ protocol: 1, token: "test-token-xyz" }),
        };
      }
      if (url === "/__bobflight_build" && init?.method === "POST") {
        assert.equal(init.headers["X-Bobflight-Build-Token"], "test-token-xyz");
        assert.equal(init.headers["Content-Type"], "application/json");
        const body = JSON.parse(init.body);
        assert.equal(body.boardId, "kakute_f7_hdv");

        return {
          ok: true,
          status: 200,
          json: async () => ({
            fileName: "kakute_f7_hdv_v1.0.hex",
            hex: testHex,
            sha256: testSha,
            sourceRevision: "a".repeat(40),
            boardId: "kakute_f7_hdv",
            profile: "main",
            label: "Kakute F7 HDV Build",
            log: "Compilation successful in 1.2s",
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    try {
      flushSync(() => {
        root.render(
          <HexBuilder
            boardId="kakute_f7_hdv"
            customMcu=""
            customFlash=""
            customHse=""
            disabled={false}
            onLoad={async (f) => {
              loadedFile = f;
            }}
            onBusyChange={(b) => busyStates.push(b)}
          />
        );
      });

      const buildBtn = container.findAll((e) => e.getAttribute("class") === "btn-build-hex")[0];

      await click(buildBtn);
      await sleep(30);

      assert.deepEqual(busyStates, [true, false], "onBusyChange should be balanced [true, false]");
      assert.ok(loadedFile, "onLoad should be called with built File");
      assert.equal(loadedFile.name, "kakute_f7_hdv_v1.0.hex");

      const results = container.findAll((e) => e.getAttribute("class") === "hex-builder-result");
      assert.equal(results.length, 1);
      assert.match(results[0].textContent, /HEX built; transfer checksum verified/);
      assert.match(results[0].textContent, new RegExp(testSha));
    } finally {
      (globalThis as any).fetch = originalFetch;
      flushSync(() => root.unmount());
    }
  }

  // 4. Local builder unavailable error handling (GET 404 / static host)
  console.log("Test 4: Browser / static host local builder unavailable handling");
  {
    const { container } = installFakeDom();
    const root = createRoot(container as never);

    let busyStates: boolean[] = [];

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string) => {
      if (url === "/__bobflight_build") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Not found" }),
        };
      }
      throw new Error("404");
    };

    try {
      flushSync(() => {
        root.render(
          <HexBuilder
            boardId="kakute_f7_hdv"
            customMcu=""
            customFlash=""
            customHse=""
            disabled={false}
            onLoad={async () => {}}
            onBusyChange={(b) => busyStates.push(b)}
          />
        );
      });

      const buildBtn = container.findAll((e) => e.getAttribute("class") === "btn-build-hex")[0];
      await click(buildBtn);
      await sleep(30);

      assert.deepEqual(busyStates, [true, false]);
      const errors = container.findAll((e) => e.getAttribute("class") === "hex-builder-error");
      assert.equal(errors.length, 1);
      assert.match(errors[0].textContent, /Local builder unavailable/);
    } finally {
      (globalThis as any).fetch = originalFetch;
      flushSync(() => root.unmount());
    }
  }

  // 5. SHA256 Mismatch Handling
  console.log("Test 5: SHA256 checksum mismatch rejection");
  {
    const { container } = installFakeDom();
    const root = createRoot(container as never);

    const testHex = ":100000002000042000000000000000000000000030\n:00000001FF";

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (url === "/__bobflight_build" && init?.method === "GET") {
        return { ok: true, status: 200, json: async () => ({ protocol: 1, token: "tok" }) };
      }
      if (url === "/__bobflight_build" && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fileName: "bad_sha.hex",
            hex: testHex,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          }),
        };
      }
      throw new Error("Unexpected fetch");
    };

    try {
      flushSync(() => {
        root.render(
          <HexBuilder
            boardId="kakute_f7_hdv"
            customMcu=""
            customFlash=""
            customHse=""
            disabled={false}
            onLoad={async () => {}}
            onBusyChange={() => {}}
          />
        );
      });

      const buildBtn = container.findAll((e) => e.getAttribute("class") === "btn-build-hex")[0];
      await click(buildBtn);
      await sleep(30);

      const errors = container.findAll((e) => e.getAttribute("class") === "hex-builder-error");
      assert.equal(errors.length, 1);
      assert.match(errors[0].textContent, /SHA256 checksum mismatch/);
    } finally {
      (globalThis as any).fetch = originalFetch;
      flushSync(() => root.unmount());
    }
  }

  console.log("Test 6: Changed selection and unmount discard in-flight results");
  for (const mode of ["selection", "unmount"]) {
    const {container}=installFakeDom();const root=createRoot(container as never);
    const oldFetch=globalThis.fetch;let loaded=0,posts=0,finish:(value:unknown)=>void=()=>{};const states:boolean[]=[];
    const hex=":00000001FF";const sha256=await computeSha256Node(hex);
    globalThis.fetch=(async (_url:unknown, init?:RequestInit)=>{
      if(init?.method==="GET")return {ok:true,json:async()=>({protocol:1,token:"fixture"})};
      posts++;return await new Promise(resolve=>{finish=resolve;});
    }) as typeof fetch;
    const render=(boardId:string)=>flushSync(()=>root.render(<HexBuilder boardId={boardId} customMcu="" customFlash="" customHse="" disabled={false} onLoad={async()=>{loaded++;}} onBusyChange={v=>states.push(v)}/>));
    try {
      render("kakute_f7_hdv");const button=container.findAll(e=>e.getAttribute("class")==="btn-build-hex")[0];
      await click(button);await click(button);assert.equal(posts,1);
      if(mode==="selection")render("tmotor_f7_v2");else flushSync(()=>root.unmount());
      finish({ok:true,json:async()=>({boardId:"kakute_f7_hdv",hex,sha256,fileName:"bobflight-kakute_f7_hdv-main.hex",profile:"main",sourceRevision:"a".repeat(40)})});
      for(let i=0;i<100&&states.length<2;i++)await sleep(5);
      assert.equal(loaded,0);assert.deepEqual(states,[true,false]);
      assert.equal(container.findAll(e=>e.getAttribute("class")==="hex-builder-result").length,0);
    } finally {globalThis.fetch=oldFetch;if(mode!=="unmount")flushSync(()=>root.unmount());}
  }

  console.log("\nALL HEXBUILDER TESTS PASSED SUCCESSFULLY! ✓\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
