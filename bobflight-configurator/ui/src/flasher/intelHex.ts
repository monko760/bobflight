/**
 * Intel HEX — prefer @bobflight/protocol parseIntelHex; UI opts for FlasherPage.
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseIntelHex as protocolParseIntelHex } from "@bobflight/protocol";
import { toUiParsedHex, normalizeMcu, type ParsedHex } from "./types";
import { catalog, mcuForBoard } from "../targets/catalog";

/** [word, MCU] filename hints derived from the catalog's hardware boards (no hardcoded names). */
export function boardNameHints(): [string, string][] {
  const rows = catalog.boards.filter(b => b.support !== "host-only").map(b => [b.id.split(/[_-]/)[0], normalizeMcu(mcuForBoard(b.id)?.part)] as const);
  const count = (w: string) => rows.filter(r => r[0] === w).length;
  return rows.filter((r): r is readonly [string, NonNullable<typeof r[1]>] => !!r[1] && r[0].length >= 4 && count(r[0]) === 1).map(r => [r[0], r[1]]);
}

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
  const explicit = /(?:stm32)?([fh]\d{3})(?!\d)/i.exec(name);
  if (explicit) return explicit[1].toUpperCase();
  // Board-name hints from the catalog: the first board_id word when it is unique.
  for (const [word, mcu] of boardNameHints()) if (n.includes(word)) return mcu;
  return undefined;
}
