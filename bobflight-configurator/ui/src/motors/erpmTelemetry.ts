/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Parse FW `get erpm_mN` replies. Never invent 0 when telem is absent.
 * R0b: M1 may return a number or `erpm_m1=none`. M2–4 often `unknown key`
 * until FW R0c indexed telem arrives.
 */
import type { MotorNumber } from "./benchController";

export type ErpmCell = {
  /** Parsed eRPM when FW returned a finite number; null = unavailable. */
  value: number | null;
  /** Short honest subtitle for the cell. */
  detail: string;
};

export const EMPTY_ERPM: Record<MotorNumber, ErpmCell> = {
  1: { value: null, detail: "Waiting telem" },
  2: { value: null, detail: "Waiting FW R0c" },
  3: { value: null, detail: "Waiting FW R0c" },
  4: { value: null, detail: "Waiting FW R0c" },
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
    return {
      value: null,
      detail: motor === 1 ? "Unavailable" : "Waiting FW R0c",
    };
  }
  const m = new RegExp(`^erpm_m${motor}=(.+)$`, "im").exec(text);
  if (!m) {
    return {
      value: null,
      detail: motor === 1 ? "Waiting telem" : "Waiting FW R0c",
    };
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

export function erpmCommand(motor: MotorNumber): `get erpm_m${MotorNumber}` {
  return `get erpm_m${motor}`;
}
