/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read-only `sd read <N>` sector transfer (FW contract from merged #42,
 * bobflight-firmware/src/drivers/sd_cli.h). Frozen sequence for every download:
 *
 *   1. a fresh `sd probe` (a probe from before a recording still says done,
 *      but reads then fail with `driver error`);
 *   2. poll `sd status` until `sd_state: done` (15 s cap), requiring
 *      `sd_sectors` and `sd_io_error: 0`;
 *   3. `sd read <N>` one 512-byte sector at a time, N canonical decimal
 *      0..capacity-1, never pipelined (FW USB TX buffer is 2048 B and an
 *      overflow is silently dropped): exactly one `sd read` in flight;
 *   4. `sd cancel`.
 *
 * The reply is asynchronous: FW prints nothing inline and the sector arrives on
 * a later background poll, as CRLF lines
 *   sd_data_api: 1 / sd_data_sector: <N> / sd_data_hex: <1024 uppercase hex> /
 *   sd_data_crc32: <8 uppercase hex> / sd_data_end: 1
 * or an `sd_data_error: <text>` line followed by `sd_data_end: 1`. The CRC is
 * IEEE CRC-32 (reflected 0xEDB88320, init and xorout 0xFFFFFFFF) over the 512
 * raw bytes. Per command: 8 s timeout, 16 KiB reply cap.
 *
 * Error and refusal lines are returned verbatim (including unknown future
 * `sd_data_error:` values); callers must show them as sent and stop.
 */

export const SD_SECTOR_BYTES = 512;
/** Per `sd read` command timeout (contract: 8 s). */
export const SD_READ_TIMEOUT_MS = 8000;
/** Per `sd read` reply cap (contract: 16 KiB). */
export const SD_READ_REPLY_CAP = 16384;
/** `sd status` polling cap after a fresh `sd probe` (contract: 15 s). */
export const SD_PROBE_TIMEOUT_MS = 15000;
/** Largest sector index the FW parser accepts (uint32). */
export const SD_MAX_SECTOR = 4294967295;

/** `sd_data_error:` texts the FW can send today (documentation and tests; any other value is still shown verbatim). */
export const SD_DATA_ERROR_TEXTS = [
  "blackbox busy",
  "read in progress",
  "disarm, stop motor tests/calibration, connect USB required",
  "card not probed or not ready",
  "malformed sector argument",
  "sector out of bounds",
  "begin read failed",
  "guard check failed",
  "driver error",
  "no hardware backend in host simulation",
] as const;

/** Probe/status refusals named by the contract (shown verbatim; other `sd unavailable:`/`sd refused:` lines are too). */
export const SD_PROBE_REFUSALS = [
  "sd unavailable: Blackbox recording owns the card; stop and wait for done",
  "sd refused: disarm, stop motor tests/calibration, connect USB, and wait or cancel the current probe",
] as const;

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** IEEE CRC-32 (zlib/FW `sd_cli_crc32`). */
export function crc32Ieee(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC as the FW prints it: 8 uppercase hex digits. */
export function formatCrc32(crc: number): string {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** `sd read <N>` with N canonical decimal (no sign, no leading zeros), 0..2^32-1. */
export function formatSdReadCommand(sector: number): `sd read ${number}` {
  if (!Number.isSafeInteger(sector) || sector < 0 || sector > SD_MAX_SECTOR) {
    throw new Error(`invalid SD sector index: ${String(sector)}`);
  }
  return `sd read ${sector}` as `sd read ${number}`;
}

export type SdReadResult =
  /** CRC verified sector. */
  | { kind: "data"; sector: number; bytes: Uint8Array; crc: string }
  /** Well-formed reply whose CRC does not match its bytes (caller may retry once). */
  | { kind: "crc-mismatch"; sector: number; sentCrc: string; actualCrc: string }
  /** `sd_data_error: ...` line, verbatim. */
  | { kind: "error"; sector: number; line: string }
  /** Another FW refusal (`unknown — try help`, `sd unavailable: ...`, `command refused: ...`), verbatim. */
  | { kind: "refused"; sector: number; line: string }
  /** No complete reply within the per-command timeout. */
  | { kind: "timeout"; sector: number; timeoutMs: number }
  /** Framing/identity violation: never trusted, never retried as data. */
  | { kind: "malformed"; sector: number; reason: string };

const REFUSAL_LINE = /^(?:unknown\b|sd unavailable:|sd refused:|command refused:)/;

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Parse one complete `sd read` reply for the requested sector.
 * Strict: exact key set, the requested sector only, 1024 uppercase hex digits,
 * 8 uppercase CRC digits, no duplicate or foreign lines, final `sd_data_end: 1`.
 */
export function parseSdReadReply(text: string, sector: number): SdReadResult {
  if (text.length > SD_READ_REPLY_CAP) return { kind: "malformed", sector, reason: `reply exceeds ${SD_READ_REPLY_CAP} characters` };
  const lines = splitLines(text);
  const error = lines.find((l) => l.startsWith("sd_data_error:"));
  if (error !== undefined) return { kind: "error", sector, line: error };
  const refusal = lines.find((l) => REFUSAL_LINE.test(l));
  if (refusal !== undefined) return { kind: "refused", sector, line: refusal };
  const fields = new Map<string, string>();
  for (const line of lines) {
    const m = /^(sd_data_[a-z0-9_]+): (.*)$/.exec(line);
    if (!m) return { kind: "malformed", sector, reason: `unexpected line in sd read reply: ${line.slice(0, 80)}` };
    if (fields.has(m[1])) return { kind: "malformed", sector, reason: `duplicate ${m[1]} in sd read reply` };
    fields.set(m[1], m[2]);
  }
  if (lines[lines.length - 1] !== "sd_data_end: 1") return { kind: "malformed", sector, reason: "sd read reply does not end with sd_data_end: 1" };
  if (fields.get("sd_data_api") !== "1") return { kind: "malformed", sector, reason: `unsupported sd_data_api: ${fields.get("sd_data_api") ?? "missing"}` };
  const got = fields.get("sd_data_sector");
  if (got === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(got)) return { kind: "malformed", sector, reason: "missing or non-canonical sd_data_sector" };
  if (got !== String(sector)) return { kind: "malformed", sector, reason: `reply is for sector ${got}, expected ${sector}` };
  const hex = fields.get("sd_data_hex");
  if (hex === undefined || !/^[0-9A-F]{1024}$/.test(hex)) return { kind: "malformed", sector, reason: "sd_data_hex is not 1024 uppercase hex digits" };
  const crc = fields.get("sd_data_crc32");
  if (crc === undefined || !/^[0-9A-F]{8}$/.test(crc)) return { kind: "malformed", sector, reason: "sd_data_crc32 is not 8 uppercase hex digits" };
  for (const k of fields.keys()) {
    if (!["sd_data_api", "sd_data_sector", "sd_data_hex", "sd_data_crc32", "sd_data_end"].includes(k)) {
      return { kind: "malformed", sector, reason: `unexpected ${k} in sd read reply` };
    }
  }
  const bytes = new Uint8Array(SD_SECTOR_BYTES);
  for (let i = 0; i < SD_SECTOR_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const actual = formatCrc32(crc32Ieee(bytes));
  if (actual !== crc) return { kind: "crc-mismatch", sector, sentCrc: crc, actualCrc: actual };
  return { kind: "data", sector, bytes, crc };
}

export type SdStatusResult =
  | {
      kind: "status";
      state: string;
      detail: string | null;
      /** `sd_sectors` exactly as sent (null if absent). */
      sectors: string | null;
      /** `sd_io_error` exactly as sent (null if absent). */
      ioError: string | null;
      filesystem: string | null;
      raw: string;
    }
  /** `sd unavailable: ...`, `sd refused: ...`, `command refused: ...`, `unknown ...` or a mock-unavailable line, verbatim. */
  | { kind: "refused"; line: string; raw: string }
  | { kind: "malformed"; reason: string; raw: string };

/** Parse an `sd probe` / `sd status` / `sd cancel` reply (sd_api 1). */
export function parseSdStatusReply(raw: string): SdStatusResult {
  const lines = splitLines(raw);
  const refusal = lines.find((l) => REFUSAL_LINE.test(l) || l === "sd_state: unavailable-mock");
  if (refusal !== undefined) return { kind: "refused", line: refusal, raw };
  const fields = new Map<string, string>();
  for (const line of lines) {
    const m = /^(sd_[a-z0-9_]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    if (fields.has(m[1])) return { kind: "malformed", reason: `duplicate ${m[1]} in SD status reply`, raw };
    fields.set(m[1], m[2]);
  }
  if (fields.get("sd_api") !== "1" || fields.get("sd_end") !== "1" || !fields.get("sd_state")) {
    return { kind: "malformed", reason: "incomplete or unsupported SD status reply (sd_api 1 with sd_state and sd_end: 1 required)", raw };
  }
  return {
    kind: "status",
    state: fields.get("sd_state") as string,
    detail: fields.get("sd_detail") ?? null,
    sectors: fields.get("sd_sectors") ?? null,
    ioError: fields.get("sd_io_error") ?? null,
    filesystem: fields.get("sd_filesystem_hint") ?? null,
    raw,
  };
}

/** Probe states while the FW is still working. */
export const SD_PROBE_ACTIVE_STATES = ["initializing", "reading-mbr", "reading-boot-sector"] as const;

/**
 * Card size in sectors from a `done` status, or a reason it cannot be used.
 * Requires a canonical non-zero `sd_sectors` and `sd_io_error: 0`.
 */
export function sdReadyCapacity(s: Extract<SdStatusResult, { kind: "status" }>): { ok: true; sectors: number } | { ok: false; reason: string } {
  if (s.state !== "done") return { ok: false, reason: `sd_state: ${s.state}` };
  if (s.sectors === null) return { ok: false, reason: "sd_sectors missing from the done status" };
  if (!/^[1-9][0-9]{0,19}$/.test(s.sectors) || !Number.isSafeInteger(Number(s.sectors))) return { ok: false, reason: `sd_sectors: ${s.sectors}` };
  if (s.ioError !== "0") return { ok: false, reason: `sd_io_error: ${s.ioError ?? "missing"}` };
  // The FW sector argument is uint32: the readable range ends at 2^32 sectors.
  return { ok: true, sectors: Math.min(Number(s.sectors), SD_MAX_SECTOR + 1) };
}

/** The UI's shared CommandGate (ui/src/protocol/commandGate.ts) shape. */
export interface SdCommandGate {
  run<T>(work: () => Promise<T>): Promise<T>;
}
/** Sends one exact CLI line and resolves with its full framed reply. */
export type SdReadSend = (cmd: `sd read ${number}`, opts: { timeoutMs: number; maxResponseChars: number }) => Promise<string>;

/** Raised (not a result) when the gate refused the request: nothing was sent, a retry is safe. */
export class SdGateBusyError extends Error {
  constructor(message: string) { super(message); this.name = "SdGateBusyError"; }
}

/**
 * Protocol-layer `sd read` helper. Holds the shared CommandGate for the whole
 * transaction (from the write until `sd_data_end: 1` for that sector arrives on
 * a later background poll), so no other command can interleave, and refuses a
 * second read while one is outstanding: reads are never pipelined.
 */
export class SdSectorReader {
  private inFlight = false;
  constructor(
    private readonly gate: SdCommandGate,
    private readonly send: SdReadSend,
    readonly timeoutMs: number = SD_READ_TIMEOUT_MS,
  ) {}

  /** True while an `sd read` is outstanding. */
  get busy(): boolean { return this.inFlight; }

  async read(sector: number): Promise<SdReadResult> {
    const cmd = formatSdReadCommand(sector);
    if (this.inFlight) throw new Error("an sd read is already in flight; reads are never pipelined");
    this.inFlight = true;
    try {
      return await this.gate.run(async () => {
        let text: string;
        try {
          text = await this.send(cmd, { timeoutMs: this.timeoutMs, maxResponseChars: SD_READ_REPLY_CAP });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/terminator missing|timed out/.test(msg)) return { kind: "timeout", sector, timeoutMs: this.timeoutMs } as const;
          if (/exceeds \d+-character limit/.test(msg)) return { kind: "malformed", sector, reason: `reply exceeds ${SD_READ_REPLY_CAP} characters` } as const;
          throw e;
        }
        return parseSdReadReply(text, sector);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/request not queued/.test(msg)) throw new SdGateBusyError(msg);
      throw e;
    } finally {
      this.inFlight = false;
    }
  }
}
