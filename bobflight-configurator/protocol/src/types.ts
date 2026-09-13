/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/** USB CDC / serial port summary for enumeratePorts(). */
export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  friendlyName?: string;
}

/** High-level connection lifecycle (never implies armed). */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Integer bench pulse percent; runtime guards enforce the same 0–35 cap. */
export type MotorPulsePercent = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35;

/** Exact FW CLI commands (lowercase; only explicitly listed arguments). */
export type CliCommand =
  | "storage" | "save" | "diff all" | "dump all"
  | "ports" | "modes"
  | `mode_range ${"ARM" | "ANGLE" | "ACRO" | "HORIZON"} ${0 | 1} ${number} ${number} ${number}`
  | `control_source ${"manual" | "aux"}`
  | "help"
  | "version"
  | "status"
  | "receiver"
  | "receiver_map AETR"
  | "receiver_map TAER"
  | "pid_diag" | "pid_diag status" | "pid_diag start" | "pid_diag start rx" | "pid_diag stop"
  | "timing"
  | "power"
  | `power_config ${number} ${number} ${number} ${number} ${number} ${number} ${number}`
  | "arm"
  | "bench_switch"
  | "bench_stop"
  | "bench_status"
  | "disarm"
  | "reboot"
  | "bl" | "bl discard"
  | "sensors"
  | "calibration"
  | "calibration_cancel"
  | "calibrate_accel start"
  | "calibrate_accel apply"
  | "calibrate_accel cancel"
  | `calibrate_accel ${"+x" | "-x" | "+y" | "-y" | "+z" | "-z"}`
  | "calibrate_gyro"
  | "motor_seq"
  | "dshot"
  | "dshot 300"
  | "dshot 600"
  | `receiver_uart ${1 | 2 | 3 | 4 | 6 | 7}`
  | `motor_test ${0 | 1 | 2 | 3 | 4}`
  | `motor_pulse ${1 | 2 | 3 | 4} ${MotorPulsePercent}`;

export interface ConnectOptions {
  path: string;
  /** Default 115200; USB CDC often ignores baud. */
  baudRate?: number;
  /** Use in-process MockSerial (path mock://... or transport: mock). */
  transport?: "serial" | "mock" | "webserial";
}

export interface SendCommandOptions {
  timeoutMs?: number;
  /** Quiet window after last byte before treating response as complete. */
  idleMs?: number;
}

/** Parsed `status` key:value lines (fail-closed markers noted in README). */
export interface ParsedStatus {
  raw: string;
  flight_mode?: string;
  gyro_calibrated?: string;
  gyro_dps?: string;
  accel_g?: string;
  attitude_deg?: string;
  rx_uart?: string;
  rx_fresh?: string;
  rx_frames?: string;
  channels?: string;
  motor_output?: string;

  board?: string;
  ir?: string;
  mcu?: string;
  gyro_ok?: "yes" | "no" | string;
  gyro_bind?: string;
  dshot_bound?: string;
  rx?: string;
  mmio?: string;
  arm?: "armed" | "disarmed" | string;
  failsafe?: "ACTIVE" | "ok" | string;
  loop?: string;
  /** True when Arm is blocked: gyro_ok:no and/or failsafe:ACTIVE (Lead). */
  failClosed: boolean;
  failClosedReasons: string[];
}

export interface ReconnectOptions {
  enabled?: boolean;
  maxAttempts?: number;
  delayMs?: number;
}
