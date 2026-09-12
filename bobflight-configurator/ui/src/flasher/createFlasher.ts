/**
 * Flasher factory — static imports from @bobflight/protocol (live + mock).
 * Local mockFlasher only if Protocol createFlasher throws at runtime.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createFlasher as protocolCreateFlasher,
  isWebUsbAvailable as protocolIsWebUsbAvailable,
  webUsbUnavailableReason as protocolWebUsbUnavailableReason,
} from "@bobflight/protocol";
import { createMockFlasher } from "./mockFlasher";
import type { Flasher } from "./types";

export type FlasherKind = "mock" | "webusb-dfu";

/** True when Protocol createFlasher is available (static import succeeded). */
export function protocolFlasherReady(): boolean {
  return typeof protocolCreateFlasher === "function";
}

/** Browser WebUSB presence (delegates to Protocol). */
export function isWebUsbAvailable(): boolean {
  try {
    return protocolIsWebUsbAvailable();
  } catch {
    return (
      typeof navigator !== "undefined" &&
      typeof (navigator as Navigator & { usb?: unknown }).usb !== "undefined"
    );
  }
}

/**
 * Human-readable reason WebUSB DFU cannot run.
 * Protocol returns null when WebUSB is available — then return empty only if live-ready.
 */
export function webUsbUnavailableReason(): string {
  try {
    const reason = protocolWebUsbUnavailableReason();
    if (reason) return reason;
    if (!isWebUsbAvailable()) {
      return "WebUSB unavailable — use Chrome/Edge on https or localhost";
    }
    // WebUSB present and Protocol ready — no unavailable reason.
    return "";
  } catch {
    if (typeof navigator === "undefined") {
      return "WebUSB requires a browser environment";
    }
    if (typeof (navigator as Navigator & { usb?: unknown }).usb === "undefined") {
      return "WebUSB unavailable — use Chrome/Edge on https or localhost";
    }
    return "WebUSB check failed";
  }
}

/**
 * Create a flasher instance via Protocol.
 * - mock: Protocol MockFlasher; local mock only if Protocol throws
 * - webusb-dfu: Protocol WebUsbDfuFlasher
 */
export function createFlasher(kind: FlasherKind = "mock"): Flasher {
  try {
    return protocolCreateFlasher(kind);
  } catch (err) {
    if (kind === "mock") {
      return createMockFlasher();
    }
    throw err instanceof Error
      ? err
      : new Error(String(err));
  }
}
