/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Parse FW `get erpm_mN` / `get dshot_telem_mN` replies. Never invent 0 when telem is absent.
 * R0c (FW PR #52): M1–M4 are first-class — `erpm_mN=<n>` if OK else `erpm_mN=none`.
 * Telem body is status-only: ok|crc_fail|invalid|timeout|stale|none.
 */
import type { MotorNumber } from "./benchController";

/** FW `dshot_telem_status_name` tokens (align Protocol / FW PR #52). */
export type DshotTelemStatus =
  | "ok"
  | "crc_fail"
  | "invalid"
  | "timeout"
  | "stale"
  | "none";

export const DSHOT_TELEM_STATUSES: readonly DshotTelemStatus[] = [
  "ok",
  "crc_fail",
  "invalid",
  "timeout",
  "stale",
  "none",
] as const;

export type ErpmCell = {
  /** Parsed eRPM when FW returned a finite number; null = unavailable. */
  value: number | null;
  /** Short honest subtitle for the cell. */
  detail: string;
};

export const EMPTY_ERPM: Record<MotorNumber, ErpmCell> = {
  1: { value: null, detail: "Waiting telem" },
  2: { value: null, detail: "Waiting telem" },
  3: { value: null, detail: "Waiting telem" },
  4: { value: null, detail: "Waiting telem" },
};

export function emptyErpmCells(): Record<MotorNumber, ErpmCell> {
  return {
    1: { ...EMPTY_ERPM[1] },
    2: { ...EMPTY_ERPM[2] },
    3: { ...EMPTY_ERPM[3] },
    4: { ...EMPTY_ERPM[4] },
  };
}

/**
 * Parse one `get erpm_mN` reply. Returns null value for none / unknown /
 * malformed — callers must not display invented zeros.
 */
export function parseErpmReply(motor: MotorNumber, raw: string): ErpmCell {
  const text = raw.trim();
  if (/unknown key/i.test(text)) {
    return { value: null, detail: "Unavailable" };
  }
  const m = new RegExp(`^erpm_m${motor}=(.+)$`, "im").exec(text);
  if (!m) {
    return { value: null, detail: "Waiting telem" };
  }
  const token = m[1].trim().toLowerCase();
  if (token === "none" || token === "") {
    return { value: null, detail: "Waiting telem" };
  }
  // Accept unsigned integer eRPM only (FW %lu). Reject non-numeric tokens.
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    return { value: null, detail: "Waiting telem" };
  }
  const n = Number(token);
  if (!Number.isFinite(n)) {
    return { value: null, detail: "Waiting telem" };
  }
  return { value: n, detail: "Live" };
}

/** Honest cell subtitle from a telem status token (never invents eRPM). */
export function detailForTelemStatus(status: DshotTelemStatus): string {
  switch (status) {
    case "ok":
      return "Live";
    case "crc_fail":
      return "CRC fail";
    case "invalid":
      return "Invalid";
    case "timeout":
      return "Timeout";
    case "stale":
      return "Stale";
    case "none":
    default:
      return "Waiting telem";
  }
}

/**
 * Parse `get dshot_telem_mN` body (status token only, no key= prefix).
 * Returns null if the reply is not a known status token.
 */
export function parseTelemReply(raw: string): DshotTelemStatus | null {
  const token = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if ((DSHOT_TELEM_STATUSES as readonly string[]).includes(token)) {
    return token as DshotTelemStatus;
  }
  return null;
}

export function erpmCommand(motor: MotorNumber): `get erpm_m${MotorNumber}` {
  return `get erpm_m${motor}`;
}

export function telemCommand(motor: MotorNumber): `get dshot_telem_m${MotorNumber}` {
  return `get dshot_telem_m${motor}`;
}
