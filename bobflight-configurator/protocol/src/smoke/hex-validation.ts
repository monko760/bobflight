/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Protocol regression test suite: Intel HEX validation & security bounds.
 * Tests fail-closed requirements:
 *  1. Malformed checksums
 *  2. Malformed record shapes for EOF, ELA, ESA, SLA
 *  3. Missing EOF and content/records after EOF
 *  4. Overlapping and duplicate data record rejection
 *  5. Safe uint32 address arithmetic at high uint32 sign edges (0x80000000, 0xFFFFFFFF)
 *  6. 2^32 address boundary rejection
 *  7. Huge gap / image span rejection (> 2 MiB) before allocation
 *  8. Input text size rejection (> 8 MiB)
 *  9. Empty image / no data records rejection
 * 10. Valid standard real-like and sparse vectors with entryAddress and MCU tag preservation
 */

import { parseIntelHex, loadHexFromUint8Array, type ParsedHex } from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function assertThrows(fn: () => unknown, pattern: RegExp, contextMsg: string): void {
  let threw = false;
  let caughtError: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    caughtError = err;
  }
  assert(threw, `Expected throw for: ${contextMsg}`);
  const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
  assert(
    pattern.test(msg),
    `Error message for '${contextMsg}' did not match ${pattern}. Got: "${msg}"`
  );
}

/** Construct a formatted Intel HEX line given body 'LLAAAATTDD...' with valid checksum. */
function makeRecord(
  ll: number,
  aaaa: number,
  tt: number,
  dataHex: string = ""
): string {
  const countStr = ll.toString(16).padStart(2, "0").toUpperCase();
  const addrStr = aaaa.toString(16).padStart(4, "0").toUpperCase();
  const typeStr = tt.toString(16).padStart(2, "0").toUpperCase();
  const body = `${countStr}${addrStr}${typeStr}${dataHex.toUpperCase()}`;

  let sum = 0;
  for (let i = 0; i < body.length; i += 2) {
    sum += parseInt(body.slice(i, i + 2), 16);
  }
  const checksum = (256 - (sum & 0xff)) & 0xff;
  const csStr = checksum.toString(16).padStart(2, "0").toUpperCase();
  return `:${body}${csStr}`;
}

async function main(): Promise<void> {
  console.log("=== BobFlight protocol hex-validation tests ===");

  // --- 1. Malformed Checksums ---
  console.log("Testing malformed checksums...");
  assertThrows(
    () => parseIntelHex(":020000040800F3\n:00000001FF\n"),
    /bad checksum/i,
    "bad checksum in ELA record"
  );
  assertThrows(
    () => parseIntelHex(":10000000000102030405060708090A0B0C0D0E0F00\n:00000001FF\n"),
    /bad checksum/i,
    "bad checksum in data record"
  );

  // --- 2. Record Shapes (EOF, ELA, ESA, SLA) ---
  console.log("Testing record shapes for EOF, ELA, ESA, SLA...");
  // EOF with count != 0
  assertThrows(
    () => parseIntelHex(`${makeRecord(2, 0, 1, "0000")}\n`),
    /malformed EOF/i,
    "EOF count != 0"
  );
  // EOF with offset != 0
  assertThrows(
    () => parseIntelHex(`${makeRecord(0, 0x0010, 1)}\n`),
    /malformed EOF/i,
    "EOF offset != 0"
  );
  // ESA count != 2
  assertThrows(
    () => parseIntelHex(`${makeRecord(1, 0, 2, "00")}\n:00000001FF\n`),
    /malformed ESA/i,
    "ESA count != 2"
  );
  // ESA offset != 0
  assertThrows(
    () => parseIntelHex(`${makeRecord(2, 0x0010, 2, "0800")}\n:00000001FF\n`),
    /malformed ESA/i,
    "ESA offset != 0"
  );
  // ELA count != 2
  assertThrows(
    () => parseIntelHex(`${makeRecord(1, 0, 4, "08")}\n:00000001FF\n`),
    /malformed ELA/i,
    "ELA count != 2"
  );
  // ELA offset != 0
  assertThrows(
    () => parseIntelHex(`${makeRecord(2, 0x0004, 4, "0800")}\n:00000001FF\n`),
    /malformed ELA/i,
    "ELA offset != 0"
  );
  // SLA count != 4
  assertThrows(
    () => parseIntelHex(`${makeRecord(2, 0, 5, "0800")}\n:00000001FF\n`),
    /malformed SLA/i,
    "SLA count != 2"
  );
  // SLA offset != 0
  assertThrows(
    () => parseIntelHex(`${makeRecord(4, 0x0004, 5, "08000001")}\n:00000001FF\n`),
    /malformed SLA/i,
    "SLA offset != 0"
  );

  // --- 3. Missing EOF and Content/Records after EOF ---
  console.log("Testing EOF presence and trailing content rejection...");
  // Missing EOF
  assertThrows(
    () => parseIntelHex(`${makeRecord(2, 0, 4, "0800")}\n${makeRecord(2, 0, 0, "AABB")}\n`),
    /missing EOF/i,
    "missing EOF record"
  );
  // Trailing data record after EOF
  assertThrows(
    () =>
      parseIntelHex(
        `${makeRecord(2, 0, 4, "0800")}\n${makeRecord(2, 0, 0, "AABB")}\n:00000001FF\n${makeRecord(2, 2, 0, "CCDD")}\n`
      ),
    /unexpected record or content after EOF/i,
    "data record after EOF"
  );
  // Trailing non-blank garbage text after EOF
  assertThrows(
    () =>
      parseIntelHex(
        `${makeRecord(2, 0, 4, "0800")}\n${makeRecord(2, 0, 0, "AABB")}\n:00000001FF\nGARBAGE_TEXT\n`
      ),
    /unexpected record or content after EOF/i,
    "garbage text after EOF"
  );

  // --- 4. Overlapping and Duplicate Data Records ---
  console.log("Testing overlapping and duplicate data record rejection...");
  // Exact duplicate record
  assertThrows(
    () =>
      parseIntelHex(
        `${makeRecord(2, 0, 4, "0800")}\n${makeRecord(4, 0, 0, "01020304")}\n${makeRecord(4, 0, 0, "01020304")}\n:00000001FF\n`
      ),
    /overlapping data records detected/i,
    "duplicate data record"
  );
  // Partial overlap
  assertThrows(
    () =>
      parseIntelHex(
        `${makeRecord(2, 0, 4, "0800")}\n${makeRecord(4, 0, 0, "01020304")}\n${makeRecord(4, 2, 0, "05060708")}\n:00000001FF\n`
      ),
    /overlapping data records detected/i,
    "partially overlapping data records"
  );

  // --- 5. High uint32 Sign Edge (0x80000000, 0xFFFFFFFF) ---
  console.log("Testing high uint32 sign edge address calculations...");
  // ELA = 0x8000 (upper address = 0x80000000 = 2,147,483,648)
  const highHex = `${makeRecord(2, 0, 4, "8000")}\n${makeRecord(4, 0, 0, "11223344")}\n:00000001FF\n`;
  const highParsed: ParsedHex = parseIntelHex(highHex);
  assert(
    highParsed.baseAddress === 0x80000000,
    `high baseAddress must be 0x80000000, got 0x${highParsed.baseAddress.toString(16)}`
  );
  assert(highParsed.bytes.length === 4, `bytes length 4`);
  assert(highParsed.bytes[0] === 0x11 && highParsed.bytes[3] === 0x44, "high payload");

  // Upper uint32 boundary (ELA = 0xFFFF, offset = 0xFFFC, count = 4 -> ends at 0x100000000)
  const topHex = `${makeRecord(2, 0, 4, "FFFF")}\n${makeRecord(4, 0xfffc, 0, "A1A2A3A4")}\n:00000001FF\n`;
  const topParsed: ParsedHex = parseIntelHex(topHex);
  assert(
    topParsed.baseAddress === 0xfffffffc,
    `top baseAddress 0xFFFFFFFC, got 0x${topParsed.baseAddress.toString(16)}`
  );
  assert(topParsed.bytes.length === 4, `top bytes length 4`);
  assert(topParsed.bytes[0] === 0xa1 && topParsed.bytes[3] === 0xa4, "top payload");

  // --- 6. Address Boundary Exceeded (2^32) ---
  console.log("Testing address boundary overflow rejection (> 2^32)...");
  assertThrows(
    () =>
      parseIntelHex(
        `${makeRecord(2, 0, 4, "FFFF")}\n${makeRecord(4, 0xfffd, 0, "A1A2A3A4")}\n:00000001FF\n`
      ),
    /out of 32-bit boundary/i,
    "address end exceeds 2^32"
  );

  // --- 7. Huge Gap / Image Span Rejection (> 2 MiB) Before Allocation ---
  console.log("Testing huge gap / image span rejection (> 2 MiB)...");
  // Record 1 at 0x08000000 (ELA 0x0800, offset 0x0000)
  // Record 2 at 0x08300000 (ELA 0x0830, offset 0x0000) -> span 0x300004 = 3,145,732 bytes (> 2 MiB)
  const hugeGapHex = `${makeRecord(2, 0, 4, "0800")}\n${makeRecord(4, 0, 0, "01020304")}\n${makeRecord(
    2,
    0,
    4,
    "0830"
  )}\n${makeRecord(4, 0, 0, "05060708")}\n:00000001FF\n`;
  assertThrows(
    () => parseIntelHex(hugeGapHex),
    /exceeds maximum allowed 2 MiB/i,
    "image span > 2 MiB"
  );

  // --- 8. Input Text Size Rejection (> 8 MiB) ---
  console.log("Testing input text size rejection (> 8 MiB)...");
  const hugeText = "A".repeat(8 * 1024 * 1024 + 1);
  assertThrows(
    () => parseIntelHex(hugeText),
    /exceeds 8 MiB limit/i,
    "input text > 8 MiB"
  );
  const hugeBuf = new Uint8Array(8 * 1024 * 1024 + 1);
  assertThrows(
    () => parseIntelHex(hugeBuf),
    /exceeds 8 MiB limit/i,
    "input Uint8Array > 8 MiB"
  );

  // --- 9. Empty Image Rejection ---
  console.log("Testing empty image / no data records rejection...");
  assertThrows(
    () => parseIntelHex(":00000001FF\n"),
    /empty image or no data records/i,
    "EOF only with no data records"
  );

  // --- 10. Valid Sparse & Standard Real-Like Vectors ---
  console.log("Testing valid standard real-like and sparse vectors...");
  // Vector with ELA 0x0800, 2 data lines (offset 0 and offset 16), SLA entry address 0x08000001, EOF
  const validHexLines = [
    makeRecord(2, 0, 4, "0800"), // ELA 0x0800 -> base 0x08000000
    makeRecord(16, 0, 0, "000102030405060708090A0B0C0D0E0F"),
    makeRecord(16, 16, 0, "101112131415161718191A1B1C1D1E1F"),
    makeRecord(4, 0, 5, "08000001"), // SLA 0x08000001
    ":00000001FF", // EOF
  ];
  const validHexStr = validHexLines.join("\n") + "\n";
  const validParsed: ParsedHex = parseIntelHex(validHexStr);
  assert(validParsed.baseAddress === 0x08000000, "baseAddress 0x08000000");
  assert(validParsed.bytes.length === 32, "bytes length 32");
  assert(validParsed.entryAddress === 0x08000001, "entryAddress 0x08000001");
  assert(validParsed.regions.length === 1, "merged into 1 region");
  assert(validParsed.regions[0].address === 0x08000000, "region address");
  assert(validParsed.regions[0].data.length === 32, "region data length");

  // Valid sparse vector (within <= 2 MiB span):
  // Region 1 at 0x08000000 (16 bytes)
  // Region 2 at 0x08000100 (16 bytes, 240 bytes gap filled with 0xFF)
  const sparseHexLines = [
    makeRecord(2, 0, 4, "0800"),
    makeRecord(16, 0x0000, 0, "000102030405060708090A0B0C0D0E0F"),
    makeRecord(16, 0x0100, 0, "F0F1F2F3F4F5F6F7F8F9FAFBFCFDFEFF"),
    ":00000001FF",
  ];
  const sparseParsed: ParsedHex = parseIntelHex(sparseHexLines.join("\n") + "\n");
  assert(sparseParsed.baseAddress === 0x08000000, "sparse baseAddress");
  assert(sparseParsed.bytes.length === 0x0110, "sparse bytes length 272");
  assert(sparseParsed.regions.length === 2, "2 distinct sparse regions");
  assert(sparseParsed.regions[0].address === 0x08000000, "region 1 addr");
  assert(sparseParsed.regions[1].address === 0x08000100, "region 2 addr");
  assert(sparseParsed.bytes[0x0010] === 0xff, "gap byte filled with 0xFF");
  assert(sparseParsed.bytes[0x0100] === 0xf0, "region 2 byte 0");

  // Verify loadHexFromUint8Array helper
  const utf8Data = new TextEncoder().encode(validHexStr);
  const loadedStr = loadHexFromUint8Array(utf8Data);
  assert(loadedStr === validHexStr, "loadHexFromUint8Array matches input");
  const parsedFromUint8: ParsedHex = parseIntelHex(utf8Data);
  assert(parsedFromUint8.baseAddress === 0x08000000, "Uint8Array input parsed baseAddress");

  // Verify MCU tag property preservation
  parsedFromUint8.mcu = "F745";
  assert(parsedFromUint8.mcu === "F745", "mcu tag preserved on ParsedHex");

  console.log("=== HEX VALIDATION PASS ===");
}

main().catch((err) => {
  console.error("=== HEX VALIDATION FAIL ===");
  console.error(err);
  process.exit(1);
});
