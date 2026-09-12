/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room WebUSB DFU flasher for ST ROM bootloader (DfuSe).
 * Knowledge from public USB DFU 1.1 + ST AN3156 / DfuSe docs only.
 * NOT derived from Betaflight Configurator or any GPL flasher.
 *
 * LOCKED assumptions (FW Lead):
 *   VID 0x0483 / PID 0xDF11, alt 0, flash base 0x08000000, leave after flash.
 * Host equivalent: dfu-util -a 0 -s 0x08000000:leave -D bobflight.bin
 */

import type { ParsedHex } from "./intel-hex";
import { assertMcuGate, normalizeFirmware } from "./mcu-gate";
import { planSectorErases } from "./flash-sectors";
import {
  DEFAULT_FLASH_BASE,
  type FlashDeviceInfo,
  type FlashOptions,
  type FlashProgress,
  type Flasher,
} from "./types";

/** ST Microelectronics DFU ROM bootloader (LOCKED). */
export const ST_DFU_VID = 0x0483;
/** ST DFU product id used by STM32 ROM DFU (LOCKED). */
export const ST_DFU_PID = 0xdf11;
/** Interface alternate setting for main flash (LOCKED; dfu-util -a 0). */
export const DEFAULT_ALT = 0;
/** STM32 flash mapped base (LOCKED). */
export { DEFAULT_FLASH_BASE };

/** USB DFU class / subclass (Interface class). */
const DFU_CLASS = 0xfe;
const DFU_SUBCLASS = 0x01;

/** DFU class-specific request codes (USB DFU 1.1 §6.1). */
const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

/** bStatus values (subset). */
const OK = 0x00;

/** bState values (subset). */
const dfuIDLE = 2;
const dfuDNLOAD_IDLE = 5;
const dfuERROR = 10;

/** DfuSe command: Set Address Pointer (AN3156). */
const DFUSE_SET_ADDRESS = 0x21;
/** DfuSe command: Erase page/sector. */
const DFUSE_ERASE = 0x41;

/** Default wTransferSize when descriptor is unavailable. */
const DEFAULT_TRANSFER_SIZE = 2048;

// --- Minimal WebUSB ambient types (no DOM lib; Node tsc-safe) ---

interface UsbConfiguration {
  configurationValue: number;
  interfaces: UsbInterface[];
}

interface UsbInterface {
  interfaceNumber: number;
  alternates: UsbAlternateInterface[];
}

interface UsbAlternateInterface {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: unknown[];
}

interface UsbDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  serialNumber?: string;
  opened?: boolean;
  configuration: UsbConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(
    interfaceNumber: number,
    alternateSetting: number
  ): Promise<void>;
  controlTransferOut(
    setup: UsbControlTransferParameters,
    data?: ArrayBuffer | ArrayBufferView
  ): Promise<UsbOutTransferResult>;
  controlTransferIn(
    setup: UsbControlTransferParameters,
    length: number
  ): Promise<UsbInTransferResult>;
}

interface UsbControlTransferParameters {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}

interface UsbOutTransferResult {
  status: "ok" | "stall" | "babble";
  bytesWritten: number;
}

interface UsbInTransferResult {
  status: "ok" | "stall" | "babble";
  data?: { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
}

interface UsbDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

interface NavigatorUsb {
  requestDevice(options: {
    filters: UsbDeviceFilter[];
  }): Promise<UsbDevice>;
  getDevices(): Promise<UsbDevice[]>;
}

function getNavigatorUsb(): NavigatorUsb | null {
  const g = globalThis as {
    navigator?: { usb?: NavigatorUsb };
  };
  const nav = g.navigator;
  if (!nav || !nav.usb) return null;
  return nav.usb;
}

function isSecureContext(): boolean {
  const g = globalThis as {
    window?: { isSecureContext?: boolean };
    isSecureContext?: boolean;
  };
  if (typeof g.window !== "undefined" && g.window !== null) {
    return g.window.isSecureContext === true;
  }
  return g.isSecureContext === true;
}

/** True when `navigator.usb` exists and the page is a secure context. */
export function isWebUsbAvailable(): boolean {
  return getNavigatorUsb() !== null && isSecureContext();
}

/** Human-readable reason WebUSB cannot be used, or null if available. */
export function webUsbUnavailableReason(): string | null {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    return "browser secure context required";
  }
  if (!isSecureContext()) {
    return "WebUSB requires a secure context (HTTPS or localhost)";
  }
  if (getNavigatorUsb() === null) {
    return "navigator.usb is not available (use Chrome/Edge with WebUSB)";
  }
  return null;
}

interface DfuStatus {
  bStatus: number;
  bwPollTimeout: number;
  bState: number;
  iString: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WebUSB DFU flasher for STM32 ROM DFU (Kakute-class / ST VID:PID).
 */
export class WebUsbDfuFlasher implements Flasher {
  readonly kind = "webusb-dfu" as const;
  private cancelled = false;
  private listeners = new Set<(p: FlashProgress) => void>();
  private device: UsbDevice | null = null;
  private claimed = false;
  private interfaceNumber = 0;
  private transferSize = DEFAULT_TRANSFER_SIZE;

  onProgress(cb: (p: FlashProgress) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private emit(p: FlashProgress): void {
    for (const cb of this.listeners) {
      try {
        cb(p);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private ensureBrowser(): void {
    const reason = webUsbUnavailableReason();
    if (reason) {
      throw new Error(reason);
    }
  }

  /** Fail-closed: only ST ROM DFU 0483:df11. */
  private assertStdfuDevice(device: UsbDevice): void {
    if (device.vendorId !== ST_DFU_VID || device.productId !== ST_DFU_PID) {
      throw new Error(
        `Not an ST ROM DFU device (expected 0483:df11, got ${device.vendorId.toString(16)}:${device.productId.toString(16)})`
      );
    }
  }

  private assertClaimedForFlash(): void {
    if (!this.device || !this.claimed) {
      throw new Error(
        "No claimed ST DFU device (0483:df11). Call requestDevice() and wait for claim before flash()."
      );
    }
    this.assertStdfuDevice(this.device);
  }

  async requestDevice(): Promise<FlashDeviceInfo> {
    this.ensureBrowser();
    const usb = getNavigatorUsb()!;
    const device = await usb.requestDevice({
      filters: [{ vendorId: ST_DFU_VID, productId: ST_DFU_PID }],
    });
    this.assertStdfuDevice(device);
    this.device = device;
    this.claimed = false; // must openDevice/claim before flash
    return {
      productName: device.productName,
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber,
    };
  }

  private throwIfCancelled(bytesWritten: number, bytesTotal: number): void {
    if (this.cancelled) {
      this.emit({
        phase: "cancelled",
        bytesWritten,
        bytesTotal,
        message: "cancelled",
      });
      throw new Error("flash cancelled");
    }
  }

  private async getStatus(device: UsbDevice): Promise<DfuStatus> {
    const result = await device.controlTransferIn(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_GETSTATUS,
        value: 0,
        index: this.interfaceNumber,
      },
      6
    );
    if (result.status !== "ok" || !result.data || result.data.byteLength < 6) {
      throw new Error("DFU_GETSTATUS failed");
    }
    const u8 = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    return {
      bStatus: u8[0],
      bwPollTimeout: u8[1] | (u8[2] << 8) | (u8[3] << 16),
      bState: u8[4],
      iString: u8[5],
    };
  }

  private async clearStatus(device: UsbDevice): Promise<void> {
    const result = await device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: DFU_CLRSTATUS,
      value: 0,
      index: this.interfaceNumber,
    });
    if (result.status !== "ok") throw new Error("DFU_CLRSTATUS failed");
  }

  private async waitUntilIdle(device: UsbDevice, context = "DFU", expectedState = dfuDNLOAD_IDLE): Promise<DfuStatus> {
    for (let i = 0; i < 100; i++) {
      if (this.cancelled) throw new Error("flash cancelled");
      const st = await this.getStatus(device);
      if (st.bStatus !== OK || st.bState === dfuERROR) {
        throw new Error(`${context}: device error status=0x${st.bStatus.toString(16)}, state=${st.bState}`);
      }
      if (st.bState === expectedState) {
        return st;
      }
      if (st.bState !== 3 && st.bState !== 4) {
        throw new Error(`${context}: unexpected DFU state ${st.bState}`);
      }
      const poll = Math.max(st.bwPollTimeout, 1);
      if (poll > 30000) throw new Error(`${context}: excessive DFU poll timeout`);
      await delay(poll);
    }
    throw new Error(`${context}: timeout waiting for idle`);
  }

  /** AN3156: UPLOAD requires dfuIDLE; ABORT ends an upload/download session. */
  private async abortToIdle(device: UsbDevice): Promise<void> {
    const result = await device.controlTransferOut({
      requestType: "class", recipient: "interface", request: DFU_ABORT,
      value: 0, index: this.interfaceNumber,
    });
    if (result.status !== "ok") throw new Error("DFU_ABORT failed");
    await this.waitUntilIdle(device, "DFU_ABORT", dfuIDLE);
  }

  /** Only recover a stale error before any erase/write in this session. */
  private async prepareDevice(device: UsbDevice): Promise<void> {
    const status = await this.getStatus(device);
    if (status.bState === dfuERROR) await this.clearStatus(device);
    else if (status.bStatus !== OK) throw new Error(`Initial DFU error ${status.bStatus}`);
    else if (![dfuIDLE, dfuDNLOAD_IDLE, 9].includes(status.bState)) {
      throw new Error(`DFU is busy (state ${status.bState}); reconnect in bootloader mode.`);
    }
    await this.abortToIdle(device);
  }

  private async dnload(
    device: UsbDevice,
    blockNum: number,
    data: Uint8Array
  ): Promise<void> {
    const result = await device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_DNLOAD,
        value: blockNum,
        index: this.interfaceNumber,
      },
      data
    );
    if (result.status !== "ok" || result.bytesWritten !== data.length) {
      throw new Error(`DFU_DNLOAD block ${blockNum} failed or short write`);
    }
  }

  /** DfuSe SET_ADDRESS then poll to idle. */
  private async dfuseSetAddress(
    device: UsbDevice,
    address: number
  ): Promise<void> {
    const cmd = new Uint8Array(5);
    cmd[0] = DFUSE_SET_ADDRESS;
    cmd[1] = address & 0xff;
    cmd[2] = (address >> 8) & 0xff;
    cmd[3] = (address >> 16) & 0xff;
    cmd[4] = (address >> 24) & 0xff;
    await this.dnload(device, 0, cmd);
    await this.waitUntilIdle(device, `Set address 0x${address.toString(16)}`);
  }

  /** DfuSe sector erase: the ROM does not erase automatically on write. */
  private async dfuseErase(device: UsbDevice, address: number): Promise<void> {
    const cmd = new Uint8Array(5);
    cmd[0] = DFUSE_ERASE;
    cmd[1] = address & 0xff;
    cmd[2] = (address >> 8) & 0xff;
    cmd[3] = (address >> 16) & 0xff;
    cmd[4] = (address >> 24) & 0xff;
    await this.dnload(device, 0, cmd);
    await this.waitUntilIdle(device, `Erase 0x${address.toString(16)}`);
  }

  private findDfuInterface(
    device: UsbDevice,
    alt: number
  ): { interfaceNumber: number; alternateSetting: number } {
    const cfg = device.configuration;
    if (!cfg) {
      throw new Error("USB device has no configuration selected");
    }
    for (const iface of cfg.interfaces) {
      for (const altSet of iface.alternates) {
        if (
          altSet.interfaceClass === DFU_CLASS &&
          altSet.interfaceSubclass === DFU_SUBCLASS &&
          altSet.alternateSetting === alt
        ) {
          return {
            interfaceNumber: iface.interfaceNumber,
            alternateSetting: altSet.alternateSetting,
          };
        }
      }
    }
    // Fallback: first DFU interface, force DEFAULT_ALT
    for (const iface of cfg.interfaces) {
      for (const altSet of iface.alternates) {
        if (
          altSet.interfaceClass === DFU_CLASS &&
          altSet.interfaceSubclass === DFU_SUBCLASS
        ) {
          return {
            interfaceNumber: iface.interfaceNumber,
            alternateSetting: alt,
          };
        }
      }
    }
    throw new Error(
      "No DFU interface (class 0xFE subclass 0x01) found on device"
    );
  }

  private async openDevice(alt: number): Promise<UsbDevice> {
    this.ensureBrowser();
    let device = this.device;
    if (!device) {
      const usb = getNavigatorUsb()!;
      const granted = await usb.getDevices();
      device =
        granted.find(
          (d) => d.vendorId === ST_DFU_VID && d.productId === ST_DFU_PID
        ) ?? null;
      if (!device) {
        throw new Error(
          "No claimed ST DFU device (0483:df11). Call requestDevice() from a user gesture first."
        );
      }
      this.assertStdfuDevice(device);
      this.device = device;
    } else {
      this.assertStdfuDevice(device);
    }

    // Windows: open() Access denied usually means WinUSB (Zadig) not bound,
    // or another process/tab already holds the device. Skip open if already open.
    try {
      if (!device.opened) {
        await device.open();
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/access denied/i.test(raw)) {
        throw new Error(
          "WebUSB open Access denied on ST DFU (0483:df11). " +
            "On Windows: Zadig → Options → List All Devices → select STM32 BOOTLOADER → " +
            "WinUSB (not libusb0/libusbK) → Replace Driver; close dfu-util/other Chrome tabs; " +
            "unplug/replug in DFU; check chrome://device-log. " +
            "ST ROM DFU is normally a single DFU interface (not CDC composite). " +
            `Detail: ${raw}`
        );
      }
      throw err;
    }
    if (!device.configuration) {
      try {
        await device.selectConfiguration(1);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        throw new Error(
          `selectConfiguration(1) failed after open: ${raw}. ` +
            "If Access denied persists, confirm WinUSB is bound to the DFU interface (Zadig)."
        );
      }
    }
    const found = this.findDfuInterface(device, alt);
    this.interfaceNumber = found.interfaceNumber;
    this.assertStdfuDevice(device);
    await device.claimInterface(this.interfaceNumber);
    await device.selectAlternateInterface(
      this.interfaceNumber,
      found.alternateSetting
    );
    // Prove DFU class responds before any success-looking write phases.
    try {
      await this.getStatus(device);
    } catch (err) {
      this.claimed = false;
      try {
        await device.releaseInterface(this.interfaceNumber);
      } catch {
        /* ignore */
      }
      throw new Error(
        `ST DFU claim failed GETSTATUS (fail-closed): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    this.claimed = true;
    return device;
  }

  private async closeDevice(device: UsbDevice): Promise<void> {
    this.claimed = false;
    try {
      await device.releaseInterface(this.interfaceNumber);
    } catch {
      /* ignore */
    }
    try {
      await device.close();
    } catch {
      /* device may have detached on leave */
    }
  }

  /**
   * Flash firmware via ST DfuSe DNLOAD + GETSTATUS poll.
   * Sequence mirrors dfu-util -a 0 -s 0x08000000:leave.
   */
  async flash(
    firmware: ParsedHex | Uint8Array,
    opts?: FlashOptions
  ): Promise<void> {
    this.cancelled = false;
    const startAddress = opts?.startAddress ?? DEFAULT_FLASH_BASE;
    const leave = opts?.leave !== false;
    const verify = opts?.verify !== false;
    const parsed = normalizeFirmware(firmware, startAddress);

    try {
      assertMcuGate(parsed, opts);
    } catch (err) {
      this.emit({
        phase: "error",
        bytesWritten: 0,
        bytesTotal: 0,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const regions = parsed.regions.length > 0
      ? parsed.regions : [{ address: parsed.baseAddress, data: parsed.bytes }];
    const eraseAddresses = planSectorErases(regions, opts?.expectedMcu ?? parsed.mcu);
    if (!Number.isSafeInteger(startAddress) || startAddress !== DEFAULT_FLASH_BASE) {
      throw new Error("This board flasher requires application base 0x08000000.");
    }

    // Node / non-browser: fail clearly (like web-serial).
    this.ensureBrowser();

    const total =
      parsed.regions.length > 0
        ? parsed.regions.reduce((n, r) => n + r.data.length, 0)
        : parsed.bytes.length;
    if (total <= 0) {
      const msg = "Refuse flash: firmware image has no bytes (fail-closed)";
      this.emit({ phase: "error", bytesWritten: 0, bytesTotal: 0, message: msg });
      throw new Error(msg);
    }

    this.emit({
      phase: "opening",
      bytesWritten: 0,
      bytesTotal: total,
      message: "opening WebUSB DFU (require claimed 0483:df11)",
    });

    let device: UsbDevice | null = null;
    try {
      device = await this.openDevice(DEFAULT_ALT);
      this.assertClaimedForFlash();
      await this.prepareDevice(device);
      this.throwIfCancelled(0, total);

      this.emit({
        phase: "erasing",
        bytesWritten: 0,
        bytesTotal: total,
        message: `DfuSe erase @ 0x${startAddress.toString(16)}`,
      });
      for (const address of eraseAddresses) {
        this.throwIfCancelled(0, total);
        this.emit({ phase: "erasing", bytesWritten: 0, bytesTotal: total,
          message: `Erasing sector at 0x${address.toString(16)} (${eraseAddresses.length} sectors)` });
        await this.dfuseErase(device, address);
      }

      let written = 0;
      for (const region of regions) {
        this.throwIfCancelled(written, total);
        let off = 0;
        while (off < region.data.length) {
          this.throwIfCancelled(written, total);
          const n = Math.min(this.transferSize, region.data.length - off);
          const chunk = region.data.subarray(off, off + n);
          // Reset pointer per chunk so a short final block cannot change the stride.
          await this.dfuseSetAddress(device, region.address + off);
          await this.dnload(device, 2, chunk);
          await this.waitUntilIdle(device, `Write 0x${(region.address + off).toString(16)}`);
          off += n;
          written += n;
          this.emit({
            phase: "writing",
            bytesWritten: written,
            bytesTotal: total,
            message: `Written ${written} / ${total} bytes`,
          });
        }
      }

      if (verify) {
        let verified = 0;
        for (const region of regions) {
          for (let off = 0; off < region.data.length; off += this.transferSize) {
            this.throwIfCancelled(written, total);
            const n = Math.min(this.transferSize, region.data.length - off);
            const address = region.address + off;
            // ROM reads require at least two bytes. At the end of flash, read
            // the preceding byte as well rather than crossing the flash limit.
            const readOffset = n === 1 && address > DEFAULT_FLASH_BASE ? 1 : 0;
            await this.dfuseSetAddress(device, address - readOffset);
            await this.abortToIdle(device);
            const result = await device.controlTransferIn({
              requestType: "class", recipient: "interface", request: DFU_UPLOAD,
              value: 2, index: this.interfaceNumber,
            }, Math.max(n, 2));
            if (result.status !== "ok" || !result.data || result.data.byteLength !== Math.max(n, 2)) {
              throw new Error(`Readback failed or short read at 0x${address.toString(16)}`);
            }
            const actual = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
            for (let i = 0; i < n; i++) {
              if (actual[i + readOffset] !== region.data[off + i]) {
                throw new Error(`Verification mismatch at 0x${(address + i).toString(16)}: expected 0x${region.data[off + i].toString(16)}, read 0x${actual[i + readOffset].toString(16)}`);
              }
            }
            await this.abortToIdle(device);
            verified += n;
            this.emit({ phase: "verifying", bytesWritten: written, bytesTotal: total,
              message: `Verified ${verified} / ${total} bytes` });
          }
        }
      }

      this.throwIfCancelled(written, total);
      if (leave) {
        this.emit({
          phase: "leaving",
          bytesWritten: written,
          bytesTotal: total,
          message: "leave DFU (zero-length DNLOAD)",
        });
        // USB DFU: zero-length DNLOAD → manifest; device jumps to app.
        // Prefaced with Set Address to flash base (dfu-util :leave style).
        await this.dfuseSetAddress(device, startAddress);
        await this.dnload(device, 0, new Uint8Array(0));
        // A successful manifestation response confirms the request, not app boot.
        let status: DfuStatus | undefined;
        try {
          status = await this.getStatus(device);
        } catch (err) {
          // STM32 may disconnect during manifestation. This does not prove
          // the application booted; the completion message still asks to reconnect.
          if (!(err instanceof Error) || err.name !== "NetworkError") throw err;
        }
        if (status && (status.bStatus !== OK || ![6, 7, 8].includes(status.bState))) {
          throw new Error(`Firmware written${verify ? " and verified" : ""}, but DFU leave failed (status=${status.bStatus}, state=${status.bState}). Replug USB.`);
        }
      }

      this.emit({
        phase: "done",
        bytesWritten: written,
        bytesTotal: total,
        message: verify ? "Firmware written and readback verified. Reconnect USB to check startup." : "Firmware written without readback verification.",
      });
    } catch (err) {
      if (this.cancelled) {
        this.emit({ phase: "cancelled", bytesWritten: 0, bytesTotal: total, message: "Flash cancelled; re-enter DFU before retrying." });
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        phase: "error",
        bytesWritten: 0,
        bytesTotal: total,
        message: msg,
      });
      throw err;
    } finally {
      if (device) {
        await this.closeDevice(device);
      }
    }
  }
}
