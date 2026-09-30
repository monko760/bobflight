/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Setup loop-rate selector actions (FW setting `loop_rate_hz`, 1000|4000|8000).
 * Reads with `get loop_rate_hz` + the framed `loop_rate` report, writes with
 * `set loop_rate_hz <v>` and persists through the existing host.saveSettings()
 * flow (flash-verified save; mock/RAM hosts refuse honestly). A change takes
 * effect only after Save + reboot. An older FC without the setting reads as
 * unknown and is never written to.
 */
import {
  loopRateSetCommand,
  parseLoopRateGetReply,
  parseLoopRateReport,
  parseLoopRateSetReply,
  type LoopRateGetResult,
  type LoopRateOption,
  type LoopRateReport,
} from "../protocol";
import type { CliCommand } from "../protocol/types";

export interface LoopRateSettingHost {
  sendCommand(cmd: CliCommand): Promise<string>;
  saveSettings(): Promise<void>;
}
export interface LoopRateSettingState {
  get: LoopRateGetResult | null;
  report: LoopRateReport | null;
  message: string;
  error: string;
}
export const LOOP_RATE_SETTING_EMPTY: LoopRateSettingState = { get: null, report: null, message: "", error: "" };
export const LOOP_RATE_SET_MESSAGE = "Selected in controller RAM. Save to controller, then reboot it, to apply.";
export const LOOP_RATE_SAVED_MESSAGE = "Saved to controller flash. Reboot the controller to apply the new loop rate.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Current setting and policy report. The report is only asked of firmware that has the setting. */
export async function readLoopRateSetting(host: LoopRateSettingHost): Promise<LoopRateSettingState> {
  const get = parseLoopRateGetReply(await host.sendCommand("get loop_rate_hz"));
  const report = get.kind === "value" ? parseLoopRateReport(await host.sendCommand("loop_rate")) : null;
  return { get, report, message: "", error: "" };
}

/** Write a new value (RAM on the FC). Refused values keep the FW's reason; the reading is refreshed either way. */
export async function selectLoopRate(host: LoopRateSettingHost, current: LoopRateSettingState, value: LoopRateOption): Promise<LoopRateSettingState> {
  if (current.get?.kind !== "value") return { ...current, error: "Loop-rate setting is not available on this firmware." };
  const result = parseLoopRateSetReply(await host.sendCommand(loopRateSetCommand(value)), value);
  const next = await readLoopRateSetting(host);
  return result.ok ? { ...next, message: LOOP_RATE_SET_MESSAGE } : { ...next, error: result.message };
}

/** Persist through the existing verified save flow, then re-read (pending stays until reboot). */
export async function saveLoopRate(host: LoopRateSettingHost, current: LoopRateSettingState): Promise<LoopRateSettingState> {
  try {
    await host.saveSettings();
  } catch (e) {
    return { ...current, message: "", error: message(e) };
  }
  return { ...(await readLoopRateSetting(host)), message: LOOP_RATE_SAVED_MESSAGE };
}

/**
 * Runtime fallbacks (overrun guard, bidir capture failure) change the applied
 * rate without any selector action. Setup feeds every polled `loop_target_hz`
 * here; a change from the last target seen means the `loop_rate` report (and
 * its reason) must be re-read so a new target is never shown next to a stale
 * reason. Unknown targets (null) are ignored; the first known target only
 * primes the watcher (the connect-time read already covers it).
 */
export class LoopTargetWatcher {
  private last: string | null = null;
  reset(): void {
    this.last = null;
  }
  /** true when `target` differs from the last known target: re-read the setting and report. */
  changed(target: string | null): boolean {
    if (target === null) return false;
    const prev = this.last;
    this.last = target;
    return prev !== null && prev !== target;
  }
}
