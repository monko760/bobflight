/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { LOOP_RATE_REBOOT_NOTE, isLoopRateOption, type LoopRateOption } from "./loop-rate-setting";
/**
 * `status` loop lines for mocks. "missing" (default) is an older FC without the
 * loop-rate keys (and without the loop_rate_hz setting), so the offline mock
 * never claims a loop rate it cannot measure. Scenario names are
 * gyro_hz/pid_denom; the target is what the FW would print. "8000/1-guard" is
 * setting 8000 with the FW overrun guard applying 8000/2 (target 4000).
 */
export const LOOP_RATE_MOCK_SCENARIOS = ["missing", "1000/1", "8000/2", "unavailable", "8000/1", "8000/1-guard"] as const;
export type LoopRateMockScenario = (typeof LOOP_RATE_MOCK_SCENARIOS)[number];

/** Replaces the `loop:` status line (and appends the loop-rate keys when present). */
export function mockLoopStatusLines(scenario: LoopRateMockScenario = "missing"): string[] {
  switch (scenario) {
    case "1000/1":
      return ["loop: gyro=1000 Hz denom=1 cascade=1000 bg=1000", "loop_target_hz: 1000", "loop_actual_hz: 999", "loop_overruns: 1"];
    case "8000/2":
      // Overruns above 2^53: Number() would round this to ...992.
      return ["loop: gyro=8000 Hz denom=2 cascade=4000 bg=4000", "loop_target_hz: 4000", "loop_actual_hz: 3998", "loop_overruns: 9007199254740993"];
    case "unavailable":
      return ["loop: gyro=8000 Hz denom=2 cascade=0 bg=0", "loop_target_hz: 4000", "loop_actual_hz: unavailable", "loop_overruns: 0"];
    case "8000/1":
      return ["loop: gyro=8000 Hz denom=1 cascade=8000 bg=8000", "loop_target_hz: 8000", "loop_actual_hz: 7996", "loop_overruns: 4"];
    case "8000/1-guard":
      return ["loop: gyro=8000 Hz denom=2 cascade=4000 bg=4000", "loop_target_hz: 4000", "loop_actual_hz: 4000", "loop_overruns: 16384"];
    case "missing":
    default:
      return ["loop: gyro=0 Hz denom=1 cascade=0 bg=0"];
  }
}

/** Boot `loop_rate_hz` a scenario was started with; null = older FC without the setting. */
export function mockLoopRateBootSetting(scenario: LoopRateMockScenario): LoopRateOption | null {
  switch (scenario) {
    case "1000/1": return "1000";
    case "8000/2": case "unavailable": return "4000";
    case "8000/1": case "8000/1-guard": return "8000";
    default: return null;
  }
}
const SCENARIO_FOR_SETTING: Record<LoopRateOption, LoopRateMockScenario> = { "1000": "1000/1", "4000": "8000/2", "8000": "8000/1" };
const PROFILE_FOR_SETTING: Record<LoopRateOption, string> = { "1000": "1000/1", "4000": "8000/2", "8000": "8000/1" };

/**
 * `get/set loop_rate_hz` and `loop_rate` for MockSerial and the UI mock host,
 * following the FW wire format. A set is RAM-only and pending until reboot();
 * reboot() returns the scenario the saved setting boots into. The mock board
 * behaves like kakute_f7_hdv (all three rates accepted; default 4000).
 */
export class MockLoopRateSetting {
  private setting: LoopRateOption | null = null;
  constructor(private scenario: () => LoopRateMockScenario) {}
  private boot(): LoopRateOption | null { return mockLoopRateBootSetting(this.scenario()); }
  current(): LoopRateOption | null { const b = this.boot(); return b === null ? null : this.setting ?? b; }
  /** FW `defaults` resets the setting to the board default (RAM until save). */
  defaults(): void { if (this.boot() !== null) this.setting = "4000"; }
  /** Soft reboot: the pending setting becomes the boot setting (mock "save" is implied). */
  reboot(): LoopRateMockScenario | null {
    const next = this.setting; this.setting = null;
    return next === null || this.boot() === null ? null : SCENARIO_FOR_SETTING[next];
  }
  handle(cmd: string, armed: boolean): string | null {
    const boot = this.boot();
    if (cmd === "get loop_rate_hz") return boot === null ? "unknown key\r\n" : `loop_rate_hz=${this.current()}\r\n`;
    if (cmd.startsWith("set loop_rate_hz ")) {
      if (boot === null) return "unknown key\r\n";
      if (armed) return "set failed: armed\r\n";
      const v = cmd.slice("set loop_rate_hz ".length);
      if (!isLoopRateOption(v)) return "set failed: loop_rate_hz must be 1000, 4000 or 8000\r\n";
      this.setting = v;
      return `ok loop_rate_hz=${v}\r\n${LOOP_RATE_REBOOT_NOTE}\r\n`;
    }
    if (cmd === "loop_rate") {
      if (boot === null) return "unknown — try help\r\n";
      const guard = this.scenario() === "8000/1-guard";
      const fast = boot !== "1000";
      return [
        "loop_rate_api: 1", `loop_rate_setting_hz: ${this.current()}`, `loop_rate_boot_setting_hz: ${boot}`,
        `loop_rate_pending_reboot: ${this.current() !== boot ? 1 : 0}`, `loop_rate_profile: ${PROFILE_FOR_SETTING[boot]}`,
        `loop_rate_active: ${guard ? "8000/2" : PROFILE_FOR_SETTING[boot]}`, `loop_rate_reason: ${guard ? "overrun-guard" : "setting"}`,
        `loop_rate_guard_level: ${guard ? 1 : 0}`, `loop_rate_gyro_odr_hz: ${fast ? 8000 : 1000}`,
        `loop_rate_gyro_spi_hz: ${fast ? 13500000 : 843750}`, "loop_rate_end: 1",
      ].join("\r\n") + "\r\n";
    }
    return null;
  }
}
