/**
 * Prefer @bobflight/protocol parsers. shouldDisableArm stays UI-local.
 * Lead lock: failClosed / Arm disable = gyro_ok:no OR failsafe:ACTIVE only.
 * mmio:denied and arm:disarmed are NOT Arm gates.
 */
import {
  parseStatus as protocolParseStatus,
  parseVersionLine as protocolParseVersionLine,
  ARM_REFUSED_PREFIX,
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
 * N2: the `arm refused: <token>` reply the FC gives while `status` already
 * shows a blocking line: the same CLI text as the firmware (tasks.c
 * arm_cli_refusal checks armed, then gyro, then failsafe). null when the
 * status shows none of them (the FC may still refuse for another reason).
 */
export function statusArmRefusal(status: ParsedStatus | null): string | null {
  if (!status) return null;
  if (status.arm === "armed") return `${ARM_REFUSED_PREFIX}already-armed`;
  if (status.gyro_ok === "no") return `${ARM_REFUSED_PREFIX}gyro-unhealthy`;
  if (status.failsafe === "ACTIVE") return `${ARM_REFUSED_PREFIX}failsafe`;
  return null;
}
