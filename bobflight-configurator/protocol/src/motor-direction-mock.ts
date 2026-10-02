/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import {
  MOTOR_DIRECTION_ARMED_LINE, MOTOR_DIRECTION_INVALID_LINE, MOTOR_DIRECTION_MOTOR_TEST_LINE, isMotorDirectionOption,
} from "./motor-direction";
/**
 * Mock FW for `motor_direction` (same wire as drivers/motor_direction_cli.h).
 *   props-out            schema 10 FC holding the default props-out
 *   props-in             schema 10 FC holding props-in
 *   refused-armed        FC armed: every set answers "set failed: armed", value unchanged
 *   refused-motor-test   a motor test is running: "set failed: motor test running", value unchanged
 *   unknown-token        a future FC holding a token this Configurator does not know
 *   old-fc               firmware before schema 10: "unknown key", no `mixer`
 * The mock mirrors the FW only to produce FW-identical replies.
 */
export const MOTOR_DIRECTION_MOCK_SCENARIOS = ["props-out", "props-in", "refused-armed", "refused-motor-test", "unknown-token", "old-fc"] as const;
export type MotorDirectionMockScenario = (typeof MOTOR_DIRECTION_MOCK_SCENARIOS)[number];
/** The future token the unknown-token scenario holds. */
export const MOTOR_DIRECTION_MOCK_FUTURE_TOKEN = "props-mixed";
/** mixer.c QUADX yaw signs for props-out (M1 RR, M2 FR, M3 RL, M4 FL); props-in negates all four. */
const PROPS_OUT_YAW = ["-1", "+1", "+1", "-1"] as const;
const PROPS_IN_YAW = ["+1", "-1", "-1", "+1"] as const;

export class MockMotorDirection {
  private token = "props-out";
  constructor(private scenario: MotorDirectionMockScenario = "props-out") { this.setScenario(scenario); }
  get supported(): boolean { return this.scenario !== "old-fc"; }
  setScenario(s: MotorDirectionMockScenario): void {
    this.scenario = s;
    this.token = s === "props-in" ? "props-in" : s === "unknown-token" ? MOTOR_DIRECTION_MOCK_FUTURE_TOKEN : "props-out";
  }
  /** FW `defaults`: props-out. */
  defaults(): void { if (this.supported) this.token = "props-out"; }
  value(): string | null { return this.supported ? this.token : null; }
  report(): string {
    const yaw = this.token === "props-in" ? PROPS_IN_YAW : PROPS_OUT_YAW;
    return `mixer_api: 1\r\nmixer: quadx\r\nmotor_direction: ${this.token}\r\n` +
      yaw.map((s, i) => `mixer_yaw_m${i + 1}: ${s}\r\n`).join("") + "mixer_end: 1\r\n";
  }
  /** FW-identical reply for a motor_direction / mixer line, or null when the line is not ours. */
  handle(line: string, armed: boolean, motorTestRunning = false): string | null {
    if (line === "mixer") return this.supported ? this.report() : "unknown — try help\r\n";
    if (line === "get motor_direction") return this.supported ? `motor_direction=${this.token}\r\n` : "unknown key\r\n";
    const s = /^set motor_direction(?: (.*))?$/.exec(line);
    if (!s) return null;
    if (s[1] === undefined || s[1].trim() === "") return "set failed\r\n";
    if (armed || this.scenario === "refused-armed") return `${MOTOR_DIRECTION_ARMED_LINE}\r\n`;
    if (!this.supported) return "unknown key\r\n";
    if (motorTestRunning || this.scenario === "refused-motor-test") return `${MOTOR_DIRECTION_MOTOR_TEST_LINE}\r\n`;
    const v = s[1].trim();
    if (!isMotorDirectionOption(v)) return `${MOTOR_DIRECTION_INVALID_LINE}\r\n`;
    this.token = v;
    return `ok motor_direction=${v}\r\n`;
  }
}
