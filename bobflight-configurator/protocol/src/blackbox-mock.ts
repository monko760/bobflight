/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Onboard Blackbox (`blackbox start|stop|status`) mock speaking the firmware
 * status contract. Default card "none" keeps the honest "unavailable" reply.
 * "ok" (api 2, default rate), "slow" (api 2, auto-lowered) and "api1" (older
 * firmware: api 1 keys only, no rate/reason/drop-% keys) are explicit,
 * deterministic simulations (one simulated second per handled command) for
 * UI/parser tests only.
 */

export type MockBlackboxCard = "none" | "ok" | "slow" | "api1";

export const MOCK_BLACKBOX_UNAVAILABLE =
  "blackbox unavailable: mock has no physical SD card\r\nblackbox_end: 1\r\n";

const REFUSED =
  "blackbox refused: disarm, stop motor tests/calibration/probe, save configuration, connect USB and finish any current recording\r\nblackbox_end: 1\r\n";

export interface OnboardStatusFields {
  state: string;
  reason: string;
  file: string;
  bytes: number;
  frames: number;
  rateHz: number;
  dropped: number;
  missed: number;
  invalid: number;
  queue: number;
  active: boolean;
  requestedHz: number;
  rateReason: string;
}

/** Same rounding as firmware: tenths = round(dropped*1000/(frames+dropped)). */
export function formatDropPct(frames: number, dropped: number): string {
  const total = frames + dropped;
  const tenths = total > 0 ? Math.floor((dropped * 1000 + Math.floor(total / 2)) / total) : 0;
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Firmware api 2 `blackbox status` text (api 1 keys and order first). */
export function formatOnboardStatus(f: OnboardStatusFields): string {
  return [
    "blackbox_api: 2",
    `blackbox_state: ${f.state}`,
    `blackbox_reason: ${f.reason}`,
    `blackbox_file: ${f.file}`,
    `blackbox_bytes: ${f.bytes}`,
    `blackbox_frames: ${f.frames}`,
    `blackbox_rate_hz: ${f.rateHz}`,
    `blackbox_dropped: ${f.dropped}`,
    `blackbox_missed: ${f.missed}`,
    `blackbox_invalid: ${f.invalid}`,
    `blackbox_queue: ${f.queue}`,
    `blackbox_active: ${f.active ? 1 : 0}`,
    `blackbox_rate_requested_hz: ${f.requestedHz}`,
    `blackbox_rate_reason: ${f.rateReason}`,
    `blackbox_drop_pct: ${formatDropPct(f.frames, f.dropped)}`,
    "blackbox_end: 1",
    "",
  ].join("\r\n");
}

/** Older firmware (blackbox api 1): same api-1 keys and order, none of the
 * api-2 keys. api-1 firmware always reported a fixed 500 Hz target. */
export function formatOnboardStatusV1(f: OnboardStatusFields): string {
  return [
    "blackbox_api: 1",
    `blackbox_state: ${f.state}`,
    `blackbox_reason: ${f.reason}`,
    `blackbox_file: ${f.file}`,
    `blackbox_bytes: ${f.bytes}`,
    `blackbox_frames: ${f.frames}`,
    `blackbox_rate_hz: ${f.rateHz}`,
    `blackbox_dropped: ${f.dropped}`,
    `blackbox_missed: ${f.missed}`,
    `blackbox_invalid: ${f.invalid}`,
    `blackbox_queue: ${f.queue}`,
    `blackbox_active: ${f.active ? 1 : 0}`,
    "blackbox_end: 1",
    "",
  ].join("\r\n");
}

const BYTES_PER_FRAME = 71;

export class MockOnboardBlackbox {
  private s: OnboardStatusFields = MockOnboardBlackbox.idle();
  private started = false;

  constructor(public card: MockBlackboxCard = "none") {}

  private static idle(): OnboardStatusFields {
    return {
      state: "idle", reason: "not-started", file: "", bytes: 0, frames: 0,
      rateHz: 500, dropped: 0, missed: 0, invalid: 0, queue: 0, active: false,
      requestedHz: 500, rateReason: "default",
    };
  }

  reset(): void {
    this.s = MockOnboardBlackbox.idle();
    this.started = false;
  }

  /** Advance one simulated second of recording. */
  private step(): void {
    if (!this.s.active) return;
    if (this.card === "api1") {
      // Legacy writer: fixed 500 Hz target, heavy queue-full losses.
      this.s.frames += 75;
      this.s.dropped += 425;
    } else if (this.card === "slow" && this.s.rateHz === this.s.requestedHz) {
      // Card cannot sustain 500 Hz: queue-full losses, then one halving.
      this.s.frames += 420;
      this.s.dropped += 80;
      this.s.rateHz = this.s.requestedHz / 2;
      this.s.rateReason = "auto-lowered-card-slow";
    } else {
      this.s.frames += this.s.rateHz;
    }
    this.s.bytes = 2400 + this.s.frames * BYTES_PER_FRAME;
  }

  /** Returns the reply for a blackbox command, or null for other commands. */
  handle(cmd: string, armed = false): string | null {
    if (cmd !== "blackbox start" && cmd !== "blackbox stop" && cmd !== "blackbox status") return null;
    if (this.card === "none") return MOCK_BLACKBOX_UNAVAILABLE;
    this.step();
    if (cmd === "blackbox start") {
      if (armed || this.s.active) return REFUSED;
      this.s = MockOnboardBlackbox.idle();
      this.s.state = "recording";
      this.s.reason = "recording";
      this.s.file = this.started ? "BFL00002.BBL" : "BFL00001.BBL";
      this.s.active = true;
      this.started = true;
    } else if (cmd === "blackbox stop" && this.s.active) {
      this.s.state = "done";
      this.s.reason = "user-stop";
      this.s.active = false;
    }
    return this.card === "api1" ? formatOnboardStatusV1(this.s) : formatOnboardStatus(this.s);
  }
}
