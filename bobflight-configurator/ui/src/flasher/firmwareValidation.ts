// Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
import { validateF405DiagnosticImage, hasF405DiagnosticMarkers } from '@bobflight/protocol';
import { BOARD_OPTIONS, type ParsedHex } from './types';
const BASE = 0x08000000;
// Matches the current supported BobFlight F7 linker/publication policies.
// The physical MCU capacity is NOT permission to overwrite reserved settings.
const PROGRAM_END = 0x08080000;
export function validateFirmwareForBoard(image: ParsedHex | null, boardId: string, filename: string | null): string | null {
  const board = BOARD_OPTIONS.find(b => b.boardId === boardId);
  if (!board) return 'Select a supported, buildable board target first.';
  if (!image || !filename) return 'Load the application HEX for the selected board.';
  if (!/\.hex$/i.test(filename)) return 'Load an Intel HEX (.hex) firmware file, not a BIN or manifest.';
  if (board.imageProfile === 'f405-usb-diagnostic') {
    const hint = /(?:stm32)?([fh]\d{3})(?!\d)/i.exec(filename)?.[1].toUpperCase();
    if (hint && hint !== 'F405') return 'Firmware filename MCU does not match F405.';
    const canonical = /^bobflight-([a-z0-9_]+)-main\.hex$/i.exec(filename);
    if (canonical) return 'A normal board main image is not the explicit F405 diagnostic.';
    try { validateF405DiagnosticImage(image); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (hasF405DiagnosticMarkers(image)) return 'F405 diagnostic cannot be flashed as a normal F7 board image.';
  if (/prove-reset|blink|diagnostic/i.test(filename)) return 'Diagnostic/blink images are not normal configurator firmware. Load the board application HEX.';
  const canonical = /^bobflight-([a-z0-9_]+)-main\.hex$/i.exec(filename);
  if (canonical && canonical[1].toLowerCase() !== boardId) return `Firmware filename names ${canonical[1]}, not selected target ${boardId}.`;
  const filenameMcu = /(?:stm32)?([fh]\d{3})(?!\d)/i.exec(filename)?.[1].toUpperCase();
  const tagged = image.mcu?.toUpperCase().replace(/^STM32/, '');
  if ((filenameMcu && filenameMcu !== board.mcu) || (tagged && tagged !== board.mcu)) return `Firmware MCU hint does not match selected ${board.mcu}. Filename hints do not prove board identity.`;
  if (image.baseAddress !== BASE || image.bytes.length < 8 || image.regions.length === 0) return 'Image must include the application vector table at 0x08000000.';
  for (const region of image.regions) {
    const end = region.address + region.data.length;
    if (!Number.isSafeInteger(region.address) || !Number.isSafeInteger(end) || region.data.length === 0 || region.address < BASE || end > PROGRAM_END) return 'Image is outside the current 512 KiB application window or overlaps reserved configuration.';
  }
  const mapped = (address: number) => image.regions.some(r => address >= r.address && address < r.address + r.data.length);
  for (let offset=0;offset<8;offset++) if (!mapped(BASE+offset)) return 'Application vector table contains missing bytes.';
  const vectors = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const stack = vectors.getUint32(0,true), reset = vectors.getUint32(4,true);
  if (stack !== 0x20010000) return 'Initial stack pointer does not match the current BobFlight F7 build policy.';
  if (!(reset & 1) || !mapped((reset & ~1) >>> 0)) return 'Reset vector is not a mapped Thumb application address.';
  if (image.entryAddress !== undefined && (!Number.isSafeInteger(image.entryAddress) || !mapped((image.entryAddress & ~1) >>> 0))) return 'HEX entry address is outside programmed application data.';
  return null;
}
