/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room Intel HEX parser (record types 00/01/02/04/05).
 * Original TypeScript — not derived from GPL flasher sources.
 */

/** Contiguous data region from HEX data records. */
export interface HexRegion {
  address: number;
  data: Uint8Array;
}

/**
 * Parsed Intel HEX image.
 * `bytes` is a single contiguous buffer from the lowest to highest covered
 * address (gaps filled with 0xFF). `regions` lists non-gap segments.
 */
export interface ParsedHex {
  baseAddress: number;
  bytes: Uint8Array;
  regions: HexRegion[];
  entryAddress?: number;
  /** Optional MCU tag for flash gating (set by caller / parseFirmware). */
  mcu?: string;
}

const HEX_LINE =
  /^:([0-9A-Fa-f]{2})([0-9A-Fa-f]{4})([0-9A-Fa-f]{2})([0-9A-Fa-f]*)([0-9A-Fa-f]{2})$/;

function parseByte(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

function verifyChecksum(rec: string): boolean {
  // rec is the payload inside ':' ... excluding trailing checksum already split;
  // full line body without colon: ll aaaatt dd.. cc
  const body = rec;
  if (body.length < 10 || body.length % 2 !== 0) return false;
  let sum = 0;
  for (let i = 0; i < body.length; i += 2) {
    sum = (sum + parseInt(body.slice(i, i + 2), 16)) & 0xff;
  }
  return sum === 0;
}

function mergeRegions(raw: HexRegion[]): HexRegion[] {
  if (raw.length === 0) return [];
  const sorted = [...raw].sort((a, b) => a.address - b.address);
  const out: HexRegion[] = [];
  let curAddr = sorted[0].address;
  let curParts: Uint8Array[] = [sorted[0].data];
  let curEnd = sorted[0].address + sorted[0].data.length;

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.address === curEnd) {
      curParts.push(r.data);
      curEnd += r.data.length;
    } else if (r.address < curEnd) {
      // Overlap: take later data as authoritative for overlapping tail
      const overlap = curEnd - r.address;
      if (overlap >= r.data.length) {
        // fully covered — skip (or could overwrite; keep first-write)
        continue;
      }
      const slice = r.data.subarray(overlap);
      curParts.push(slice);
      curEnd += slice.length;
    } else {
      const len = curEnd - curAddr;
      const buf = new Uint8Array(len);
      let off = 0;
      for (const p of curParts) {
        buf.set(p, off);
        off += p.length;
      }
      out.push({ address: curAddr, data: buf });
      curAddr = r.address;
      curParts = [r.data];
      curEnd = r.address + r.data.length;
    }
  }
  const len = curEnd - curAddr;
  const buf = new Uint8Array(len);
  let off = 0;
  for (const p of curParts) {
    buf.set(p, off);
    off += p.length;
  }
  out.push({ address: curAddr, data: buf });
  return out;
}

function buildContiguous(regions: HexRegion[]): {
  baseAddress: number;
  bytes: Uint8Array;
} {
  if (regions.length === 0) {
    return { baseAddress: 0, bytes: new Uint8Array(0) };
  }
  let min = regions[0].address;
  let max = regions[0].address + regions[0].data.length;
  for (const r of regions) {
    if (r.address < min) min = r.address;
    const end = r.address + r.data.length;
    if (end > max) max = end;
  }
  const bytes = new Uint8Array(max - min);
  bytes.fill(0xff);
  for (const r of regions) {
    bytes.set(r.data, r.address - min);
  }
  return { baseAddress: min, bytes };
}

/**
 * Load Intel HEX text from a UTF-8 byte array.
 */
export function loadHexFromUint8Array(data: Uint8Array): string {
  // Decode UTF-8 without assuming Buffer (browser-safe)
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(data);
  }
  // Node fallback
  return Buffer.from(data).toString("utf8");
}

/**
 * Parse Intel HEX (string or UTF-8 bytes).
 * Supports record types: 00 data, 01 EOF, 02 ESA, 04 ELA, 05 start linear address.
 * Rejects bad checksums and malformed lines.
 */
export function parseIntelHex(input: string | Uint8Array): ParsedHex {
  const text =
    typeof input === "string" ? input : loadHexFromUint8Array(input);

  const rawRegions: HexRegion[] = [];
  let upperLinear = 0; // from type 04 (bits 31:16)
  let segmentBase = 0; // from type 02 (para << 4)
  let entryAddress: number | undefined;
  let sawEof = false;

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (raw.length === 0) continue;
    if (!raw.startsWith(":")) {
      throw new Error(
        `Intel HEX: line ${lineNo + 1}: expected ':' record start`
      );
    }
    const body = raw.slice(1);
    if (!verifyChecksum(body)) {
      throw new Error(`Intel HEX: line ${lineNo + 1}: bad checksum`);
    }
    const m = HEX_LINE.exec(raw);
    if (!m) {
      throw new Error(`Intel HEX: line ${lineNo + 1}: malformed record`);
    }
    const count = parseInt(m[1], 16);
    const offset = parseInt(m[2], 16);
    const type = parseInt(m[3], 16);
    const dataHex = m[4];
    if (dataHex.length !== count * 2) {
      throw new Error(
        `Intel HEX: line ${lineNo + 1}: length mismatch (declared ${count})`
      );
    }

    switch (type) {
      case 0x00: {
        // Data
        const data = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          data[i] = parseByte(dataHex, i * 2);
        }
        const address = (upperLinear << 16) + segmentBase + offset;
        rawRegions.push({ address, data });
        break;
      }
      case 0x01: // EOF
        sawEof = true;
        break;
      case 0x02: {
        // Extended Segment Address
        if (count !== 2) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: ESA requires 2 data bytes`
          );
        }
        const usba = parseInt(dataHex.slice(0, 4), 16);
        segmentBase = usba << 4;
        upperLinear = 0;
        break;
      }
      case 0x04: {
        // Extended Linear Address
        if (count !== 2) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: ELA requires 2 data bytes`
          );
        }
        upperLinear = parseInt(dataHex.slice(0, 4), 16);
        segmentBase = 0;
        break;
      }
      case 0x05: {
        // Start Linear Address
        if (count !== 4) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: SLA requires 4 data bytes`
          );
        }
        entryAddress =
          ((parseByte(dataHex, 0) << 24) |
            (parseByte(dataHex, 2) << 16) |
            (parseByte(dataHex, 4) << 8) |
            parseByte(dataHex, 6)) >>>
          0;
        break;
      }
      default:
        throw new Error(
          `Intel HEX: line ${lineNo + 1}: unsupported record type 0x${type
            .toString(16)
            .padStart(2, "0")}`
        );
    }
    if (sawEof) break;
  }

  if (!sawEof) {
    throw new Error("Intel HEX: missing EOF record (type 01)");
  }

  const regions = mergeRegions(rawRegions);
  const { baseAddress, bytes } = buildContiguous(regions);
  const result: ParsedHex = { baseAddress, bytes, regions };
  if (entryAddress !== undefined) {
    result.entryAddress = entryAddress;
  }
  return result;
}
