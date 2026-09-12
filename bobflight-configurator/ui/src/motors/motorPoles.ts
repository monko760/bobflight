/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Typical 2306 FPV starting value, not a measurement of the connected motors. */
export const DEFAULT_MOTOR_POLES = 14;
export const MOTOR_POLES_KEY = "bobflight.motor-poles.v1";
export type PoleStorage = Pick<Storage, "getItem" | "setItem">;
export function validMotorPoles(value: number): boolean {
  return Number.isInteger(value) && value >= 2 && value <= 60 && value % 2 === 0;
}
export function browserPoleStorage(): PoleStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
export function readMotorPoles(storage: PoleStorage | null): number {
  try {
    const raw = storage?.getItem(MOTOR_POLES_KEY);
    if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MOTOR_POLES;
    const value = Number(raw);
    return validMotorPoles(value) ? value : DEFAULT_MOTOR_POLES;
  } catch { return DEFAULT_MOTOR_POLES; }
}
/** False means valid preference is session-only because storage was unavailable.
 * This stores only a browser preference, never motor output or firmware config. */
export function storeMotorPoles(value: number, storage: PoleStorage | null): boolean {
  if (!validMotorPoles(value)) throw new RangeError("Use an even pole count from 2 to 60.");
  if (!storage) return false;
  try { storage.setItem(MOTOR_POLES_KEY, String(value)); return true; }
  catch { return false; }
}
