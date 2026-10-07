/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room Intel HEX parser (record types 00/01/02/04/05).
 * Fail-closed parser with strict validation:
 *  - uint32 address arithmetic and 2^32 bounds checking
 *  - Overlap and duplicate record rejection
 *  - Valid record shapes and count/offset verification (EOF, ELA, ESA, SLA)
 *  - Non-blank content after EOF rejection
 *  - Empty image / no data records rejection
 *  - Bounded input text size (8 MiB) and image span (2 MiB)
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

/** Maximum allowed input text size in bytes (8 MiB). */
const MAX_TEXT_SIZE = 8 * 1024 * 1024;

/**
 * Maximum allowed image span in bytes (2 MiB).
 *
 * Current F7 MCU max flash is 1 MiB (e.g. Kakute F7 HDV), future H7 boards are
 * often 2 MiB. Maximum allowed image span is bounded to 2 MiB (2,097,152 bytes)
 * to prevent unbounded gap buffer allocation.
 */
const MAX_IMAGE_SPAN = 2 * 1024 * 1024;

/** Maximum allowed byte address boundary (2^32 = 4,294,967,296). */
const MAX_ADDRESS = 0x100000000;

const HEX_LINE =
  /^:([0-9A-Fa-f]{2})([0-9A-Fa-f]{4})([0-9A-Fa-f]{2})([0-9A-Fa-f]*)([0-9A-Fa-f]{2})$/;

function parseByte(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

function verifyChecksum(rec: string): boolean {
  if (rec.length < 10 || rec.length % 2 !== 0) return false;
  let sum = 0;
  for (let i = 0; i < rec.length; i += 2) {
    sum = (sum + parseInt(rec.slice(i, i + 2), 16)) & 0xff;
  }
  return sum === 0;
}

/**
 * Merge adjacent sorted non-overlapping regions into contiguous segments.
 */
function mergeAdjacentRegions(sorted: HexRegion[]): HexRegion[] {
  if (sorted.length === 0) return [];
  const out: HexRegion[] = [];
  let curAddr = sorted[0].address;
  let curParts: Uint8Array[] = [sorted[0].data];
  let curEnd = sorted[0].address + sorted[0].data.length;

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.address === curEnd) {
      curParts.push(r.data);
      curEnd += r.data.length;
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

/**
 * Load Intel HEX text from a UTF-8 byte array.
 */
export function loadHexFromUint8Array(data: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(data);
  }
  return Buffer.from(data).toString("utf8");
}

/**
 * Parse Intel HEX (string or UTF-8 bytes).
 * Supports record types: 00 data, 01 EOF, 02 ESA, 04 ELA, 05 SLA.
 *
 * Fail-closed validation rules:
 *  - Enforces text size <= 8 MiB and image span <= 2 MiB before allocation
 *  - Validates record shapes and zero offset for EOF (01), ESA (02), ELA (04), SLA (05)
 *  - Performs safe uint32 address calculation (max 2^32 boundary)
 *  - Rejects overlapping or duplicate data records
 *  - Rejects non-blank records/content after EOF
 *  - Rejects empty images with no data
 */
export function parseIntelHex(input: string | Uint8Array): ParsedHex {
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_TEXT_SIZE) {
      throw new Error(
        `Intel HEX: input size ${input.byteLength} bytes exceeds 8 MiB limit`
      );
    }
  } else if (typeof input === "string") {
    if (input.length > MAX_TEXT_SIZE) {
      throw new Error(
        `Intel HEX: input size ${input.length} bytes exceeds 8 MiB limit`
      );
    }
  }

  const text =
    typeof input === "string" ? input : loadHexFromUint8Array(input);

  const rawRegions: HexRegion[] = [];
  let upperLinear = 0; // from type 04 (ELA, bits 31:16)
  let segmentBase = 0; // from type 02 (ESA, para << 4)
  let entryAddress: number | undefined;
  let sawEof = false;

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (raw.length === 0) continue;

    if (sawEof) {
      throw new Error(
        `Intel HEX: line ${lineNo + 1}: unexpected record or content after EOF`
      );
    }

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
        if (count === 0) {
          // Zero-length data record; no bytes to store
          break;
        }
        const data = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          data[i] = parseByte(dataHex, i * 2);
        }
        // Safe uint32 address arithmetic without bitwise signed wrap
        const base = upperLinear * 65536 + segmentBase;
        const address = base + offset;
        if (address < 0 || address + count > MAX_ADDRESS) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: address 0x${address.toString(
              16
            )} out of 32-bit boundary (max 2^32)`
          );
        }
        rawRegions.push({ address, data });
        break;
      }
      case 0x01: // EOF
        if (count !== 0 || offset !== 0) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: malformed EOF record (expected count 0 and offset 0000)`
          );
        }
        sawEof = true;
        break;
      case 0x02: {
        // Extended Segment Address
        if (count !== 2 || offset !== 0) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: malformed ESA record (expected count 2 and offset 0000)`
          );
        }
        const usba = parseInt(dataHex.slice(0, 4), 16);
        segmentBase = usba * 16;
        upperLinear = 0;
        break;
      }
      case 0x04: {
        // Extended Linear Address
        if (count !== 2 || offset !== 0) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: malformed ELA record (expected count 2 and offset 0000)`
          );
        }
        upperLinear = parseInt(dataHex.slice(0, 4), 16);
        segmentBase = 0;
        break;
      }
      case 0x05: {
        // Start Linear Address
        if (count !== 4 || offset !== 0) {
          throw new Error(
            `Intel HEX: line ${lineNo + 1}: malformed SLA record (expected count 4 and offset 0000)`
          );
        }
        entryAddress =
          (parseByte(dataHex, 0) * 0x1000000 +
            parseByte(dataHex, 2) * 0x10000 +
            parseByte(dataHex, 4) * 0x100 +
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
  }

  if (!sawEof) {
    throw new Error("Intel HEX: missing EOF record (type 01)");
  }

  if (rawRegions.length === 0) {
    throw new Error("Intel HEX: empty image or no data records found");
  }

  // Sort raw data regions by address for overlap check and region merging
  const sortedRaw = [...rawRegions].sort((a, b) => a.address - b.address);

  // Reject overlapping or duplicate records
  for (let i = 0; i < sortedRaw.length - 1; i++) {
    const curEnd = sortedRaw[i].address + sortedRaw[i].data.length;
    const nextStart = sortedRaw[i + 1].address;
    if (nextStart < curEnd) {
      throw new Error(
        `Intel HEX: overlapping data records detected at address 0x${nextStart.toString(
          16
        )}`
      );
    }
  }

  const minAddress = sortedRaw[0].address;
  const lastRegion = sortedRaw[sortedRaw.length - 1];
  const maxAddress = lastRegion.address + lastRegion.data.length;
  const imageSpan = maxAddress - minAddress;

  // Current F7 MCU max flash is 1 MiB (e.g. Kakute F7 HDV), future H7 boards are often 2 MiB.
  // Maximum allowed image span is bounded to 2 MiB (2,097,152 bytes) to prevent unbounded gap buffer allocation.
  if (imageSpan > MAX_IMAGE_SPAN) {
    throw new Error(
      `Intel HEX: image span of ${imageSpan} bytes (0x${minAddress.toString(
        16
      )}..0x${maxAddress.toString(
        16
      )}) exceeds maximum allowed 2 MiB (2,097,152 bytes)`
    );
  }

  const bytes = new Uint8Array(imageSpan);
  bytes.fill(0xff);
  for (const r of sortedRaw) {
    bytes.set(r.data, r.address - minAddress);
  }

  const regions = mergeAdjacentRegions(sortedRaw);
  const result: ParsedHex = {
    baseAddress: minAddress,
    bytes,
    regions,
  };
  if (entryAddress !== undefined) {
    result.entryAddress = entryAddress;
  }
  return result;
}
