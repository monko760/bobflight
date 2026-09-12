/**
 * Intel HEX — prefer @bobflight/protocol parseIntelHex; UI opts for FlasherPage.
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseIntelHex as protocolParseIntelHex } from "@bobflight/protocol";
import { toUiParsedHex, type ParsedHex } from "./types";

export class IntelHexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelHexError";
  }
}

/**
 * Parse Intel HEX text into a UI ParsedHex (Protocol fields + startAddress/byteLength).
 */
export function parseIntelHex(
  text: string,
  opts?: { mcuHint?: string },
): ParsedHex {
  try {
    const proto = protocolParseIntelHex(text);
    return toUiParsedHex(proto, opts?.mcuHint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IntelHexError(msg);
  }
}

/** Infer MCU hint from filename (best-effort; not authoritative). */
export function mcuHintFromFilename(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("f745") || n.includes("kakute")) return "F745";
  if (n.includes("f722") || n.includes("tmotor")) return "F722";
  return undefined;
}
