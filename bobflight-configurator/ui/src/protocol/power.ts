export const powerKeys = ["voltage_scale", "current_mv_per_amp", "current_offset_mv", "cells", "warning_cell_v", "critical_cell_v", "capacity_mah"] as const;
export type PowerKey = typeof powerKeys[number];
export interface PowerReading extends Record<PowerKey, number> {
  valid: number; present: number; current_valid: number; consumption_valid: number;
  voltage: number; amps: number; consumed_mah: number; warning: string;
}
export function parsePower(raw: string): PowerReading {
  if (raw.includes("power_config refused:")) throw new Error(raw.trim());
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([a-z_]+): (.+)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  if (fields.power_api !== "1" || fields.power_end !== "1" || !["ram","flash","host_sim","unsupported"].includes(fields.persistence)) {
    throw new Error("No complete battery response. Install firmware with Power & Battery support.");
  }
  const result: Record<string, number | string> = { warning: fields.warning };
  for (const key of [...powerKeys, "valid", "present", "current_valid", "consumption_valid", "voltage", "amps", "consumed_mah"]) {
    if (!fields[key]?.trim() || !Number.isFinite(Number(fields[key]))) throw new Error("Incomplete battery readings.");
    result[key] = Number(fields[key]);
  }
  for (const key of ["valid", "present", "current_valid", "consumption_valid"]) {
    if (result[key] !== 0 && result[key] !== 1) throw new Error("Invalid battery health flags.");
  }
  return result as unknown as PowerReading;
}
