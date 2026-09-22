/**
 * Local mock Rates/PID store until Protocol exposes get/set.
 * Key names locked to FW/Lead contract — do not rename.
 */

export type RatesConfig = {
  rate_max_roll: number;
  rate_max_pitch: number;
  rate_max_yaw: number;
  rate_expo: number;
};

export type PidConfig = {
  pid_roll_p: number;
  pid_roll_i: number;
  pid_roll_d: number;
  pid_pitch_p: number;
  pid_pitch_i: number;
  pid_pitch_d: number;
  pid_yaw_p: number;
  pid_yaw_i: number;
  min_throttle: number;
  airmode: number;
  // pid_yaw_d omitted for now (Lead)
};

export const RATES_DEFAULTS: RatesConfig = {
  rate_max_roll: 800,
  rate_max_pitch: 800,
  rate_max_yaw: 800,
  rate_expo: 0.3,
};

export const PID_DEFAULTS: PidConfig = {
  pid_roll_p: 0.002,
  pid_roll_i: 0.001,
  pid_roll_d: 0.00005,
  pid_pitch_p: 0.002,
  pid_pitch_i: 0.001,
  pid_pitch_d: 0.00005,
  pid_yaw_p: 0.002,
  pid_yaw_i: 0.001,
  min_throttle: 0.05,
  airmode: 0,
};

let ratesState: RatesConfig = { ...RATES_DEFAULTS };
let pidState: PidConfig = { ...PID_DEFAULTS };

export function getRates(): RatesConfig {
  return { ...ratesState };
}

export function setRates(next: RatesConfig): void {
  ratesState = { ...next };
}

export function resetRates(): RatesConfig {
  ratesState = { ...RATES_DEFAULTS };
  return getRates();
}

export function getPid(): PidConfig {
  return { ...pidState };
}

export function setPid(next: PidConfig): void {
  pidState = { ...next };
}

export function resetPid(): PidConfig {
  pidState = { ...PID_DEFAULTS };
  return getPid();
}
