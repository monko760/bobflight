/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Firmware flasher types (USB DFU path — separate from CDC CLI).
 */

import type { ParsedHex } from "./intel-hex";

/** Progress phases for a flash session. */
export type FlashPhase =
  | "idle"
  | "opening"
  | "erasing"
  | "writing"
  | "verifying"
  | "leaving"
  | "done"
  | "error"
  | "cancelled";

export interface FlashProgress {
  phase: FlashPhase;
  bytesWritten: number;
  bytesTotal: number;
  message?: string;
}

/**
 * BobFlight MCU families for flash gating.
 * Primary board kakute_f7_hdv → F745; secondary tmotor_f7_v2 → F722.
 * NEVER flash an F722 image onto an F745 (or vice versa).
 */
export type BobFlightMcu = "F745" | "F722";

export interface FlashOptions {
  /** Flash base; ST ROM DFU default 0x08000000 (LOCKED). */
  startAddress?: number;
  /** Read-back verify after write (default true for live DFU). */
  verify?: boolean;
  /** Leave DFU / jump to app after flash (default true; dfu-util :leave). */
  leave?: boolean;
  /**
   * Expected target MCU. When set, refuse firmware tagged for a different MCU
   * and refuse images that exceed that MCU's flash size.
   */
  expectedMcu?: BobFlightMcu | string;
}

export interface FlashDeviceInfo {
  productName?: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

export interface Flasher {
  readonly kind: "mock" | "webusb-dfu";
  /** WebUSB user-gesture device picker (optional on mock). */
  requestDevice?(): Promise<FlashDeviceInfo>;
  flash(
    firmware: ParsedHex | Uint8Array,
    opts?: FlashOptions
  ): Promise<void>;
  cancel(): void;
  onProgress(cb: (p: FlashProgress) => void): () => void;
}

/**
 * Host flash capabilities (LOCKED by FW Lead).
 * Flash is ST ROM USB DFU + WebUSB only — no CLI flash hooks.
 * After leave, identity is via CDC CLI `status` board: field.
 */
export const FLASH_CAPABILITIES = {
  supportsCliFlash: false,
  supportsWebUsbDfu: true,
  supportsMock: true,
  /** dfu-util accepts a raw BIN here, not Intel HEX. */
  hostEquivalent:
    "dfu-util -a 0 -s 0x08000000:leave -D bobflight.bin",
} as const;

/** Board name → MCU (status board: field after leave → CDC). */
export const BOARD_MCU: Readonly<Record<string, BobFlightMcu>> = {
  kakute_f7_hdv: "F745",
  tmotor_f7_v2: "F722",
};

/** Public ST flash sizes used for gating (bytes from 0x08000000). */
export const MCU_FLASH_SIZE: Readonly<Record<BobFlightMcu, number>> = {
  F745: 1024 * 1024, // STM32F745 — 1 MiB
  F722: 512 * 1024, // STM32F722 — 512 KiB
};

export const DEFAULT_FLASH_BASE = 0x08000000;
