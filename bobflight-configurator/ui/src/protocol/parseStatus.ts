/**
 * Prefer @bobflight/protocol parsers. shouldDisableArm stays UI-local.
 * Lead lock: failClosed / Arm disable = gyro_ok:no OR failsafe:ACTIVE only.
 * mmio:denied and arm:disarmed are NOT Arm gates.
 */
import {
  parseStatus as protocolParseStatus,
  parseVersionLine as protocolParseVersionLine,
  type ParsedStatus,
} from "@bobflight/protocol";

export function parseStatus(raw: string): ParsedStatus {
  return protocolParseStatus(raw);
}

export function parseVersionLine(text: string): string {
  return protocolParseVersionLine(text);
}

/** DISABLE Arm when gyro_ok:no OR failsafe:ACTIVE only. */
export function shouldDisableArm(status: ParsedStatus | null): boolean {
  if (!status) return true;
  if (status.gyro_ok === "no") return true;
  if (status.failsafe === "ACTIVE") return true;
  return false;
}
