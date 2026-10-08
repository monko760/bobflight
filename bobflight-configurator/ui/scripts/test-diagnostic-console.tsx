/**
 * DiagnosticConsole and DiagnosticConsoleSession Unit and Integration Tests.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import {
  DiagnosticConsoleSession,
  KNOWN_BANNER_FRAGMENT,
  TARGET_PID,
  TARGET_VID,
  type MinimalSerialPort,
  type SerialOptions,
  type SerialOutputSignals,
  type SerialPortInfo,
} from "../src/flasher/diagnostic-console-session";
import { DiagnosticConsole } from "../src/flasher/DiagnosticConsole";

const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");

class MockSerialPort implements MinimalSerialPort {
  public opened = false;
  public closed = false;
  public signalsSet: SerialOutputSignals | null = null;
  public writtenChunks: Uint8Array[] = [];

  private controller!: ReadableStreamDefaultController<Uint8Array>;
  public readableStream: ReadableStream<Uint8Array>;
  public writableStream: WritableStream<Uint8Array>;

  constructor(
    public vid = TARGET_VID,
    public pid = TARGET_PID
  ) {
    this.readableStream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.controller = ctrl;
      },
    });

    this.writableStream = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writtenChunks.push(chunk);
      },
    });
  }

  getInfo(): SerialPortInfo {
    return { usbVendorId: this.vid, usbProductId: this.pid };
  }

  async open(_options: SerialOptions): Promise<void> {
    this.opened = true;
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signalsSet = signals;
  }

  async close(): Promise<void> {
    assert.equal(this.readableStream.locked,false,"reader released before port close");
    assert.equal(this.writableStream.locked,false,"writer released before port close");
    this.closed = true;
  }

  get readable() {
    return this.readableStream;
  }

  get writable() {
    return this.writableStream;
  }

  pushChunk(text: string) {
    const encoder = new TextEncoder();
    this.controller.enqueue(encoder.encode(text));
  }

  closeController() {
    try {
      this.controller.close();
    } catch {}
  }

  errorController(err: Error) {
    try {
      this.controller.error(err);
    } catch {}
  }

  getWrittenText(): string {
    const decoder = new TextDecoder();
    return this.writtenChunks.map((c) => decoder.decode(c)).join("");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTests() {
  console.log("Starting DiagnosticConsole test suite...");

  // 1. Fixed commands before identity denied / no port control writes
  console.log("Test 1: Fixed commands before identity denied");
  {
    const session = new DiagnosticConsoleSession();
    await assert.rejects(
      async () => {
        await session.sendCommand("version");
      },
      /Cannot send command/
    );
    assert.equal(session.isVerified(), false);
  }

  // 2. Wrong VID / PID rejection
  console.log("Test 2: Wrong VID/PID rejection");
  {
    const wrongPort = new MockSerialPort(0x0483, 0xdf11); // ST DFU
    let active = false;
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => wrongPort,
      onActiveChange: (a) => {
        active = a;
      },
    });

    await session.connect();
    assert.equal(session.getState(), "disconnected");
    assert.equal(active, false);
    assert.match(session.getLastError() || "", /Invalid USB device VID\/PID/);
    assert.equal(wrongPort.opened, false);
  }

  // 3. Picker / open failure
  console.log("Test 3: Picker and open failure");
  {
    // Picker error
    const sessionPickerFail = new DiagnosticConsoleSession({
      requestPortOverride: async () => {
        throw new Error("User cancelled port picker");
      },
    });
    await sessionPickerFail.connect();
    assert.equal(sessionPickerFail.getState(), "disconnected");
    assert.match(sessionPickerFail.getLastError() || "", /User cancelled port picker/);

    // Open error
    const openFailPort = new MockSerialPort();
    openFailPort.open = async () => {
      throw new Error("Port access denied");
    };
    const sessionOpenFail = new DiagnosticConsoleSession({
      requestPortOverride: async () => openFailPort,
    });
    await sessionOpenFail.connect();
    assert.equal(sessionOpenFail.getState(), "disconnected");
    assert.match(sessionOpenFail.getLastError() || "", /Port access denied/);
  }

  // 4. Timeout cleanup
  console.log("Test 4: Timeout cleanup (10s banner timeout)");
  {
    const mockPort = new MockSerialPort();
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => mockPort,
      timeoutMs: 50, // Short timeout for test
    });

    await session.connect();
    assert.equal(session.getState(), "verifying");
    await sleep(100);

    assert.equal(session.getState(), "disconnected");
    assert.equal(session.isVerified(), false);
    assert.match(session.getLastError() || "", /Diagnostic identity timeout/);
    assert.equal(mockPort.closed, true);
  }

  // 5. Partial banner assembly & commands after verified
  console.log("Test 5 & 6: Partial banner assembly & commands after verified");
  {
    const mockPort = new MockSerialPort();
    let activeState = false;
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => mockPort,
      onActiveChange: (a) => {
        activeState = a;
      },
      timeoutMs: 5000,
    });

    await session.connect();
    assert.equal(activeState, true);
    assert.equal(session.getState(), "verifying");
    assert.equal(session.isVerified(), false);

    // Send banner in 3 partial chunks
    mockPort.pushChunk("Banner: BobFlight F405 ");
    await sleep(20);
    assert.equal(session.isVerified(), false);

    mockPort.pushChunk("USB diagnostic, ML");
    await sleep(20);
    assert.equal(session.isVerified(), false);

    mockPort.pushChunk("TEMPF4 reference\r\nReady\r\n");
    await sleep(30);

    assert.equal(session.isVerified(), true);
    assert.equal(session.getState(), "connected");
    assert.equal(mockPort.signalsSet?.dataTerminalReady, true);
    assert.equal(mockPort.signalsSet?.requestToSend, false);

    // Send fixed commands
    await session.sendCommand("version");
    await session.sendCommand("status");
    await session.sendCommand("help");

    assert.equal(mockPort.getWrittenText(), "version\nstatus\nhelp\n");

    // Invalid command rejected
    await assert.rejects(
      async () => {
        await session.sendCommand("unrestricted_command" as any);
      },
      /Command 'unrestricted_command' is not allowed/
    );

    // Clean close
    await session.close();
    assert.equal(session.getState(), "disconnected");
    assert.equal(activeState, false);
    assert.equal(mockPort.closed, true);
  }

  // 7. Disconnect handling
  console.log("Test 7: Disconnect handling");
  {
    const mockPort = new MockSerialPort();
    let activeState = false;
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => mockPort,
      onActiveChange: (a) => {
        activeState = a;
      },
    });

    await session.connect();
    mockPort.pushChunk(`${KNOWN_BANNER_FRAGMENT}\r\n`);
    await sleep(30);
    assert.equal(session.getState(), "connected");

    // Disconnect port from reader side
    mockPort.closeController();
    await sleep(50);

    assert.equal(session.getState(), "disconnected");
    assert.equal(activeState, false);
  }

  // 8. Cancel pending cleanup
  console.log("Test 8: Cancel pending cleanup during opening");
  {
    const mockPort = new MockSerialPort();
    mockPort.open = async () => {
      await sleep(50);
    };
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => mockPort,
    });

    const connectPromise = session.connect();
    await sleep(10);
    // User cancels while open is pending
    await session.close();
    await connectPromise;

    assert.equal(session.getState(), "disconnected");
    assert.equal(mockPort.closed, true);
  }

  // 9. Output bounding (16 KiB limit)
  console.log("Test 9: Output bounding (16 KiB limit)");
  {
    const mockPort = new MockSerialPort();
    const session = new DiagnosticConsoleSession({
      requestPortOverride: async () => mockPort,
    });

    await session.connect();
    mockPort.pushChunk(KNOWN_BANNER_FRAGMENT);
    await sleep(20);

    // Push large text (> 16 KiB = 16384 chars)
    const largeChunk = "X".repeat(20000);
    mockPort.pushChunk(largeChunk);
    await sleep(30);

    assert.equal(session.getOutput().length, 16384);
    await session.close();
  }

  // 10. React Component UI Integration Tests
  console.log("Test 10: React DiagnosticConsole component rendering and props");
  {
    const { container } = installFakeDom();
    const root = createRoot(container as never);

    let activeState = false;
    const mockPort = new MockSerialPort();

    const requestPortOverride = async () => mockPort;

    flushSync(() => {
      root.render(
        <DiagnosticConsole
          disabled={false}
          onActiveChange={(act) => {
            activeState = act;
          }}
          requestPortOverride={requestPortOverride}
        />
      );
    });

    // Check DOM elements
    const buttons = container.findAll((e) => e.tagName === "BUTTON");
    const connectBtn = buttons.find((b) => b.getAttribute("class") === "btn-connect-diagnostic")!;
    const closeBtn = buttons.find((b) => b.getAttribute("class") === "btn-close-diagnostic")!;
    const versionBtn = buttons.find((b) => b.getAttribute("class") === "btn-command-version")!;

    assert.ok(connectBtn, "Connect button should exist");
    assert.ok(closeBtn, "Close button should exist");
    assert.ok(versionBtn, "Version command button should exist");

    assert.equal(isDisabled(connectBtn), false, "Connect button enabled initially");
    assert.equal(isDisabled(closeBtn), true, "Close button disabled initially");
    assert.equal(isDisabled(versionBtn), true, "Version button disabled initially before connection");

    // Test disabled prop blocks connecting
    flushSync(() => {
      root.render(
        <DiagnosticConsole
          disabled={true}
          onActiveChange={(act) => {
            activeState = act;
          }}
          requestPortOverride={requestPortOverride}
        />
      );
    });

    assert.equal(isDisabled(connectBtn), true, "Connect button disabled when disabled prop is true");

    // Enable back and connect
    flushSync(() => {
      root.render(
        <DiagnosticConsole
          disabled={false}
          onActiveChange={(act) => {
            activeState = act;
          }}
          requestPortOverride={requestPortOverride}
        />
      );
    });

    // Unmount
    flushSync(() => root.unmount());
  }

  {
    console.log("Test 11: Close waits for an in-flight write and blocks new commands");
    const port=new MockSerialPort();let release!:()=>void;
    port.writableStream=new WritableStream({write:()=>new Promise<void>(r=>{release=r;})});
    const session=new DiagnosticConsoleSession({requestPortOverride:async()=>port});
    await session.connect();port.pushChunk(KNOWN_BANNER_FRAGMENT);await sleep(10);
    const writing=session.sendCommand('status');await sleep(1);
    const closing=session.close();await sleep(1);
    assert.equal(port.closed,false);assert.equal(session.getState(),'closing');
    await assert.rejects(()=>session.sendCommand('help'),/not connected/);
    release();await writing;await closing;assert.equal(port.closed,true);assert(!session.isVerified());
  }
  {
    console.log("Test 12: Cancelled picker keeps exclusive ownership until it settles");
    let resolve!:(p:MinimalSerialPort)=>void;let picks=0;const port=new MockSerialPort();
    const session=new DiagnosticConsoleSession({requestPortOverride:()=>{picks++;return new Promise(r=>{resolve=r;});}});
    const opening=session.connect();const closing=session.close();await session.connect();
    assert.equal(picks,1);assert.equal(session.getState(),'closing');
    resolve(port);await opening;await closing;assert(!port.opened);assert.equal(session.getState(),'disconnected');
  }
  console.log("PASS: All DiagnosticConsole tests succeeded!");
}

void runTests().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
