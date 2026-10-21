/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * Board identity reported by firmware `version` (frozen by the Config Lead):
 *   board_id: <id>       (equals boards/<id>.yaml)
 *   board_target: <mcu backend id, e.g. stm32f745>
 *   board_mcu: <MCU part, lower case, e.g. stm32f745>
 * Values are tokens over [a-z0-9_-] only. Anything else is never trusted: the UI shows
 * `unknown` plus the verbatim text. A missing key (older firmware) is `missing`.
 * No arithmetic or normalisation is applied to FC-derived values.
 */
export const BOARD_ID_KEYS = ["board_id", "board_target", "board_mcu"] as const;
export type BoardIdKey = (typeof BOARD_ID_KEYS)[number];
export const BOARD_ID_TOKEN = /^[a-z0-9_-]+$/;

export type BoardIdField =
  | { kind: "value"; token: string }
  | { kind: "missing" }
  | { kind: "malformed"; raw: string };
export type BoardIdentity = Record<BoardIdKey, BoardIdField>;
export const BOARD_ID_MAX = 48;

/**
 * `version` has no end marker and the client ends a reply after an idle pause, so a reply
 * can be cut anywhere. Rules (Config Lead, #97 review):
 * - A key counts ONLY on a CRLF-terminated line; the unterminated tail is ignored, so a cut
 *   inside a value never yields a shorter valid-looking token.
 * - A key that appears more than once is malformed (shows `unknown (a | b)`).
 * - All three keys must be valid tokens. Otherwise none is trusted: valid ones are reported as
 *   malformed (shown `unknown (<verbatim>)`), missing ones stay missing.
 */
export function parseBoardIdentity(versionReply: string): BoardIdentity {
  const lines = versionReply.split("\r\n").slice(0, -1); // complete CRLF lines only
  const out = {} as BoardIdentity;
  for (const key of BOARD_ID_KEYS) {
    const hits = lines.filter((l) => l.startsWith(key + ":")).map((l) => l.slice(key.length + 1).replace(/^ /, ""));
    if (hits.length === 0) out[key] = { kind: "missing" };
    else if (hits.length > 1) out[key] = { kind: "malformed", raw: hits.join(" | ") };
    else out[key] = hits[0].length <= BOARD_ID_MAX && BOARD_ID_TOKEN.test(hits[0])
      ? { kind: "value", token: hits[0] } : { kind: "malformed", raw: hits[0] };
  }
  if (!BOARD_ID_KEYS.every((k) => out[k].kind === "value"))
    for (const k of BOARD_ID_KEYS) { const f = out[k]; if (f.kind === "value") out[k] = { kind: "malformed", raw: f.token }; }
  return out;
}

/** True only when all three keys were read as valid tokens. */
export function boardIdentityComplete(id: BoardIdentity): boolean {
  return BOARD_ID_KEYS.every((k) => id[k].kind === "value");
}

/** Text shown for one field: the token verbatim, `unknown` when missing, `unknown (<raw>)` when malformed. */
export function boardIdFieldText(f: BoardIdField | undefined): string {
  if (!f || f.kind === "missing") return "unknown";
  return f.kind === "value" ? f.token : `unknown (${f.raw})`;
}

export type BoardIdMockScenario = "old-firmware" | "match" | "unknown-id" | "board-mismatch" | "mcu-mismatch" | "malformed";
export const BOARD_ID_MOCK_SCENARIOS: readonly BoardIdMockScenario[] =
  ["old-firmware", "match", "unknown-id", "board-mismatch", "mcu-mismatch", "malformed"];

/** Mock `version` reply (CRLF framed like the FW). `match` is a Kakute F7 HDV build. */
export function boardIdMockVersion(s: BoardIdMockScenario): string {
  const head = "BobFlight 0.2.0-prototype-flightdev1-bl1-calstore2-piddiag2-sdprobe2-bbl2-sdread1\r\n";
  const id = (a: string, t: string, m: string) => `${head}board_id: ${a}\r\nboard_target: ${t}\r\nboard_mcu: ${m}\r\n`;
  switch (s) {
    case "old-firmware": return head;
    case "match": return id("kakute_f7_hdv", "stm32f745", "stm32f745");
    case "unknown-id": return id("acme_f7_prototype", "stm32f745", "stm32f745");
    case "board-mismatch": return id("matek_f722_px", "stm32f722", "stm32f722");
    case "mcu-mismatch": return id("kakute_f7_hdv", "stm32f722", "stm32f722");
    case "malformed": return id("Kakute F7 HDV!", "stm32f745", "STM32F745");
  }
}
