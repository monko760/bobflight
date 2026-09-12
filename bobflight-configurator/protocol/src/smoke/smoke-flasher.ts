/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Smoke: Intel HEX parse + MockFlasher progress / cancel / MCU gate.
 * Does not exercise live WebUSB DFU (Node has no navigator.usb).
 */

import {
  BOARD_MCU,
  FLASH_CAPABILITIES,
  MockFlasher,
  ST_DFU_PID,
  ST_DFU_VID,
  createFlasher,
  isWebUsbAvailable,
  parseFirmware,
  parseIntelHex,
  webUsbUnavailableReason,
  type FlashPhase,
  type FlashProgress,
} from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

/** Tiny synthetic HEX: ELA 0x0800 + 16 data bytes + SLA + EOF. */
function syntheticHex(): string {
  // :02 0000 04 0800 F2
  // :10 0000 00 000102030405060708090A0B0C0D0E0F xx
  // :04 0000 05 08000001 xx
  // :00 0000 01 FF
  const lines = [
    ":020000040800F2",
    ":10000000000102030405060708090A0B0C0D0E0F78",
    ":0400000508000001EE",
    ":00000001FF",
  ];
  // Verify checksums locally for the data line we crafted
  return lines.join("\n") + "\n";
}

function checksumOk(line: string): boolean {
  const body = line.slice(1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 2) {
    sum = (sum + parseInt(body.slice(i, i + 2), 16)) & 0xff;
  }
  return sum === 0;
}

async function main(): Promise<void> {
  console.log("=== BobFlight flasher smoke (MockFlasher) ===");

  assert(FLASH_CAPABILITIES.supportsCliFlash === false, "no CLI flash");
  assert(FLASH_CAPABILITIES.supportsMock === true, "mock supported");
  assert(FLASH_CAPABILITIES.supportsWebUsbDfu === true, "webusb flag");
  assert(ST_DFU_VID === 0x0483, "VID");
  assert(ST_DFU_PID === 0xdf11, "PID");
  assert(BOARD_MCU.kakute_f7_hdv === "F745", "primary board MCU");
  assert(BOARD_MCU.tmotor_f7_v2 === "F722", "secondary board MCU");
  console.log("OK: FLASH_CAPABILITIES + DFU constants");

  // WebUSB unavailable on Node
  assert(isWebUsbAvailable() === false, "no WebUSB on Node");
  const reason = webUsbUnavailableReason();
  assert(reason !== null, "webUsbUnavailableReason set");
  console.log("OK: WebUSB blocked on Node:", reason);

  const live = createFlasher("webusb-dfu");
  let liveThrew = false;
  try {
    await live.flash(new Uint8Array([0x00]), { expectedMcu: "F745" });
  } catch (e) {
    liveThrew = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert(
      /browser secure context required|secure context|navigator\.usb/i.test(
        msg
      ),
      `expected browser error, got: ${msg}`
    );
    console.log("OK: webusb-dfu throws on Node:", msg);
  }
  assert(liveThrew, "webusb-dfu must throw on Node");

  // --- Intel HEX ---
  const hex = syntheticHex();
  for (const line of hex.trim().split("\n")) {
    assert(checksumOk(line), `checksum ${line}`);
  }
  const parsed = parseIntelHex(hex);
  assert(parsed.baseAddress === 0x08000000, `base ${parsed.baseAddress}`);
  assert(parsed.bytes.length === 16, `len ${parsed.bytes.length}`);
  assert(parsed.bytes[0] === 0x00 && parsed.bytes[15] === 0x0f, "payload");
  assert(parsed.regions.length >= 1, "regions");
  assert(parsed.entryAddress === 0x08000001, "entry");
  console.log(
    "OK: parseIntelHex base=0x" + parsed.baseAddress.toString(16),
    "bytes=" + parsed.bytes.length
  );

  // Bad checksum rejected
  let bad = false;
  try {
    parseIntelHex(":10000000000102030405060708090A0B0C0D0E0F00\n:00000001FF\n");
  } catch {
    bad = true;
  }
  assert(bad, "bad checksum rejected");
  console.log("OK: bad checksum rejected");

  const viaHelper = await parseFirmware(hex, { mcu: "F745" });
  assert(viaHelper.mcu === "F745", "parseFirmware mcu tag");
  assert(viaHelper.baseAddress === 0x08000000, "parseFirmware base");

  // --- Mock flash happy path ---
  const flasher = createFlasher("mock");
  assert(flasher.kind === "mock", "kind mock");
  const phases: FlashPhase[] = [];
  const messages: string[] = [];
  const off = flasher.onProgress((p: FlashProgress) => {
    phases.push(p.phase);
    if (p.message) messages.push(p.message);
  });

  await flasher.flash(viaHelper, {
    expectedMcu: "F745",
    leave: true,
    verify: true,
  });
  off();

  assert(messages.length > 0, "mock progress messages");
  for (const m of messages) {
    assert(
      m.includes("[MOCK — no USB]"),
      `mock message must be unmistakable: ${m}`
    );
  }
  console.log("OK: mock progress tagged [MOCK — no USB]");

  assert(phases.includes("opening"), "phase opening");
  assert(phases.includes("erasing"), "phase erasing");
  assert(phases.includes("writing"), "phase writing");
  assert(phases.includes("verifying"), "phase verifying");
  assert(phases.includes("leaving"), "phase leaving");
  assert(phases.includes("done"), "phase done");
  assert(!phases.includes("error"), "no error");
  assert(!phases.includes("cancelled"), "no cancel");
  console.log("OK: mock flash phases:", phases.join(" -> "));

  // --- MCU gate: F722 hex on F745 refused ---
  const wrong = await parseFirmware(hex, { mcu: "F722" });
  const gate = new MockFlasher({ tickMs: 0 });
  let gated = false;
  try {
    await gate.flash(wrong, { expectedMcu: "F745" });
  } catch (e) {
    gated = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert(/MCU gate/i.test(msg), `gate message: ${msg}`);
    console.log("OK: MCU gate refused F722 on F745:", msg);
  }
  assert(gated, "MCU mismatch must throw");

  // --- Cancel mid-write ---
  const canceller = new MockFlasher({ chunkBytes: 4, tickMs: 20 });
  const cPhases: FlashPhase[] = [];
  canceller.onProgress((p) => {
    cPhases.push(p.phase);
    if (p.phase === "writing" && p.bytesWritten > 0) {
      canceller.cancel();
    }
  });
  let cancelled = false;
  try {
    await canceller.flash(viaHelper, { expectedMcu: "F745" });
  } catch (e) {
    cancelled = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert(/cancel/i.test(msg), `cancel msg: ${msg}`);
  }
  assert(cancelled, "cancel must reject");
  assert(cPhases.includes("cancelled") || cPhases.includes("writing"), "saw write/cancel");
  console.log("OK: cancel mid-write:", cPhases.join(" -> "));

  // requestDevice on mock
  const info = await flasher.requestDevice?.();
  assert(info && info.vendorId === ST_DFU_VID, "mock requestDevice VID");
  console.log("OK: mock requestDevice", info);

  console.log("=== SMOKE FLASHER PASS ===");
}

main().catch((err) => {
  console.error("=== SMOKE FLASHER FAIL ===");
  console.error(err);
  process.exit(1);
});
