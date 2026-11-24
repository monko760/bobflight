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

/**
 * N2: why Arm check is disabled, worded from the `status` lines themselves
 * ("Disabled while status shows failsafe: ACTIVE"). It never predicts the
 * board's `arm` reply: the firmware checks more than status shows (on MCU
 * builds e.g. no-motor-output and receiver-stale come before gyro and
 * failsafe), so the only `arm refused: …` text the UI shows is a reply the
 * board actually sent. null when none of these status lines blocks.
 */
export function statusArmRefusal(status: ParsedStatus | null): string | null {
  if (!status) return null;
  const lines: string[] = [];
  if (status.arm === "armed") lines.push("arm: armed");
  if (status.gyro_ok === "no") lines.push("gyro_ok: no");
  if (status.failsafe === "ACTIVE") lines.push("failsafe: ACTIVE");
  return lines.length ? `${STATUS_DISABLED_PREFIX}${lines.join(" and ")}` : null;
}

/** Prefix of every status-worded Arm check disabled reason. */
export const STATUS_DISABLED_PREFIX = "Disabled while status shows ";
