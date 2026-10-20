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

export function parseBoardIdentity(versionReply: string): BoardIdentity {
  const out = {} as BoardIdentity;
  const lines = versionReply.split(/\r?\n/);
  for (const key of BOARD_ID_KEYS) {
    const hits = lines.filter((l) => l.startsWith(key + ":"));
    if (hits.length === 0) { out[key] = { kind: "missing" }; continue; }
    const raw = hits[0].slice(key.length + 1).replace(/^ /, "");
    out[key] = hits.length === 1 && raw.length <= 48 && BOARD_ID_TOKEN.test(raw)
      ? { kind: "value", token: raw }
      : { kind: "malformed", raw: hits.length === 1 ? raw : hits.map((h) => h.slice(key.length + 1).trim()).join(" | ") };
  }
  return out;
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
