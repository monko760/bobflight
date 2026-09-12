/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParsedStatus } from "./types.js";

const KNOWN_KEYS = [
  "board",
  "flight_mode",
  "gyro_calibrated",
  "gyro_dps",
  "accel_g",
  "attitude_deg",
  "rx_uart",
  "rx_fresh",
  "rx_frames",
  "channels",
  "motor_output",

  "ir",
  "mcu",
  "gyro_ok",
  "gyro_bind",
  "dshot_bound",
  "rx",
  "mmio",
  "arm",
  "failsafe",
  "loop",
] as const;

type KnownKey = (typeof KNOWN_KEYS)[number];

/**
 * Parse FW `status` reply: lines of `key: value` (FW uses CRLF).
 *
 * Arm fail-closed gate (Lead): only gyro_ok:no and/or failsafe:ACTIVE.
 * arm:disarmed is normal safe state — NOT an Arm gate.
 * mmio:denied is informational (not an Arm gate).
 */
export function parseStatus(raw: string): ParsedStatus {
  const map: Partial<Record<KnownKey, string>> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim() as KnownKey;
    const value = trimmed.slice(idx + 1).trim();
    if ((KNOWN_KEYS as readonly string[]).includes(key)) {
      map[key] = value;
    }
  }

  const failClosedReasons: string[] = [];
  if(map.flight_mode === "bench-only") failClosedReasons.push("bench firmware: flight arming disabled");
  if(map.gyro_calibrated === "no") failClosedReasons.push("gyro calibration incomplete");
  if(map.rx_fresh === "no") failClosedReasons.push("receiver data stale");
  if (map.gyro_ok === "no") failClosedReasons.push("gyro_ok:no");
  if (map.failsafe === "ACTIVE") failClosedReasons.push("failsafe:ACTIVE");

  return {
    raw,
    flight_mode: map.flight_mode,
    gyro_calibrated: map.gyro_calibrated,
    gyro_dps: map.gyro_dps,
    accel_g: map.accel_g,
    attitude_deg: map.attitude_deg,
    rx_uart: map.rx_uart,
    rx_fresh: map.rx_fresh,
    rx_frames: map.rx_frames,
    channels: map.channels,
    motor_output: map.motor_output,

    board: map.board,
    ir: map.ir,
    mcu: map.mcu,
    gyro_ok: map.gyro_ok,
    gyro_bind: map.gyro_bind,
    dshot_bound: map.dshot_bound,
    rx: map.rx,
    mmio: map.mmio,
    arm: map.arm,
    failsafe: map.failsafe,
    loop: map.loop,
    failClosed: failClosedReasons.length > 0,
    failClosedReasons,
  };
}

/** Extract product+version from `version` reply or connect banner. */
export function parseVersionLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // version: "BobFlight 0.1.0-skeleton"
    // banner:  "BobFlight 0.1.0-skeleton ready"
    const m = /^(BobFlight\s+\S+?)(?:\s+ready)?$/.exec(line);
    if (m) return m[1];
  }
  return (lines[0] ?? text.trim()).replace(/\s+ready$/, "").trim();
}
