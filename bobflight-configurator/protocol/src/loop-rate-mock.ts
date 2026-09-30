/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * `status` loop lines for mocks. "missing" (default) is an older FC without the
 * loop-rate keys, so the offline mock never claims a loop rate it cannot measure.
 * Scenario names are gyro_hz/pid_denom; the target is what the FW would print.
 */
export const LOOP_RATE_MOCK_SCENARIOS = ["missing", "1000/1", "8000/2", "unavailable"] as const;
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
    case "missing":
    default:
      return ["loop: gyro=0 Hz denom=1 cascade=0 bg=0"];
  }
}
