/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * Board auto-detect from firmware `version` (board_id / board_target / board_mcu).
 * - Read through the shared CommandGate with the readRpm retry budget (30 x 100 ms).
 *   A gate that stays busy shows `unknown` with the gate's message: never "older firmware".
 * - Tokens are shown verbatim; a missing key shows `unknown`; a malformed value shows
 *   `unknown (<verbatim>)` and is never trusted for selection or matching.
 * - No arithmetic on FC-derived values. Nothing here feeds the StoragePanel.
 */
import { parseBoardIdentity, boardIdentityComplete, boardIdFieldText, type BoardIdentity } from "@bobflight/protocol";
import { gated, RpmCancelled } from "../filters/rpmFilter";
import { isGateBusy } from "../protocol/commandGate";
import { BOARD_OPTIONS, normalizeMcu, type BoardOption } from "./types";

export type IdentityRead =
  | { kind: "idle" }
  | { kind: "read"; identity: BoardIdentity }
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string }
  | { kind: "stale"; message: string };

export interface VersionHost { sendCommand(cmd: "version"): Promise<string>; }

export async function readBoardIdentity(host: VersionHost, signal?: AbortSignal): Promise<IdentityRead> {
  try {
    const raw = await gated(() => host.sendCommand("version"), signal);
    return { kind: "read", identity: parseBoardIdentity(raw) };
  } catch (e) {
    if (e instanceof RpmCancelled) throw e;
    const message = e instanceof Error ? e.message : String(e);
    return isGateBusy(e) ? { kind: "busy", message } : { kind: "error", message };
  }
}

export interface IdentityView {
  boardId: string; target: string; mcu: string;
  /** Trusted tokens only: all three keys valid and board_target == board_mcu. Else null. */
  fcBoardId: string | null; fcTarget: string | null; fcMcu: string | null;
  /** Catalog board to pre-select: trusted id that is in the catalog and whose catalog MCU equals board_mcu. */
  preselect: string | null;
  /** True when a re-read can help (connected and identity unknown, busy, error or incomplete). */
  canRetry: boolean;
  note: string | null;
}

export function identityView(read: IdentityRead, options: readonly BoardOption[] = BOARD_OPTIONS): IdentityView {
  const blank = { boardId: "unknown", target: "unknown", mcu: "unknown", fcBoardId: null, fcTarget: null, fcMcu: null, preselect: null };
  if (read.kind === "idle") return { ...blank, canRetry: false, note: "Connect the flight controller to read its board identity, or select the board manually." };
  if (read.kind === "busy") return { ...blank, canRetry: true, note: `Board identity not read: CLI busy (${read.message}). Read again or select the board manually.` };
  if (read.kind === "error") return { ...blank, canRetry: true, note: `Board identity not read: error (${read.message}). Read again or select the board manually.` };
  if (read.kind === "stale") return { ...blank, canRetry: false, note: `Board identity unknown: ${read.message}. Select the board manually and confirm it.` };
  const id = read.identity;
  const shown = { boardId: boardIdFieldText(id.board_id), target: boardIdFieldText(id.board_target), mcu: boardIdFieldText(id.board_mcu) };
  if (BOARD_ID_KEYS_ALL_MISSING(id))
    return { ...blank, ...shown, canRetry: true, note: "Firmware does not report board identity (older firmware). Select the board manually." };
  if (!boardIdentityComplete(id))
    return { ...blank, ...shown, canRetry: true, note: "Board identity incomplete or not valid (board_id, board_target and board_mcu are all required as plain tokens) and is not trusted. Read again or select the board manually." };
  const t = { id: (id.board_id as { token: string }).token, target: (id.board_target as { token: string }).token, mcu: (id.board_mcu as { token: string }).token };
  if (t.target !== t.mcu)
    return { ...blank, ...shown, canRetry: true, note: `Board identity inconsistent: board_target ${t.target} differs from board_mcu ${t.mcu}; not trusted. Select the board manually.` };
  const entry = options.find((b) => b.boardId === t.id);
  const note = !entry
    ? `Board ${t.id} is not known to this Configurator. Flashing is blocked; update the Configurator. DFU recovery is unaffected.`
    : catalogMcuToken(entry.mcu) !== t.mcu
      ? `Board ${t.id} reports board_mcu ${t.mcu}, but this Configurator's catalog lists ${entry.mcuDisplay}. Nothing pre-selected.`
      : null;
  return { ...shown, fcBoardId: t.id, fcTarget: t.target, fcMcu: t.mcu, preselect: entry && note === null ? t.id : null, canRetry: false, note };
}

function BOARD_ID_KEYS_ALL_MISSING(id: BoardIdentity): boolean {
  return id.board_id.kind === "missing" && id.board_target.kind === "missing" && id.board_mcu.kind === "missing";
}

/** Catalog MCU family (e.g. F745) in the FC token form (stm32f745). Catalog data only. */
function catalogMcuToken(mcu: string | null | undefined): string | null {
  const n = normalizeMcu(mcu ?? undefined);
  return n ? "stm32" + n.toLowerCase() : null;
}

export interface IdentityGate { blocked: boolean; needsConfirm: boolean; reasons: string[]; hexMarker: "unknown"; }

/**
 * - FC board_mcu that differs from the selected board's MCU, or from the HEX MCU, ALWAYS blocks.
 * - A valid FC board_id that differs from the selected board blocks.
 * - Otherwise a selection that the FC did not confirm (unknown/missing/malformed/busy id) is a
 *   manual selection and needs the explicit confirm. HEX board markers arrive in PR C: `unknown`.
 */
/** `dfu`: live DFU flashing. The DFU device cannot be tied to the CDC session that reported the
 *  identity, so there the identity only pre-selects and hard-blocks mismatches; the manual confirm
 *  is always required (Config Lead ruling (c) on #97). */
export function identityGate(view: IdentityView, selected: BoardOption | undefined, hexMcu: string | null | undefined, manualConfirmed: boolean, dfu = false, options: readonly BoardOption[] = BOARD_OPTIONS): IdentityGate {
  const reasons: string[] = [];
  let hard = false;
  if (view.fcBoardId !== null && !options.some((b) => b.boardId === view.fcBoardId)) {
    hard = true; reasons.push(`Unknown board: flight controller reports board_id ${view.fcBoardId}, which this Configurator does not know. No override.`);
  }
  if (selected) {
    const want = catalogMcuToken(selected.mcu);
    for (const [key, v] of [["board_mcu", view.fcMcu], ["board_target", view.fcTarget]] as const)
      if (v !== null && want !== v) { hard = true; reasons.push(`MCU mismatch: flight controller reports ${key} ${v}; selected board ${selected.boardId} is ${selected.mcuDisplay}.`); }
  }
  if (view.fcMcu !== null && hexMcu) {
    const hex = catalogMcuToken(hexMcu);
    if (hex !== null && hex !== view.fcMcu) { hard = true; reasons.push(`MCU mismatch: flight controller reports board_mcu ${view.fcMcu}; firmware file is for ${hexMcu}.`); }
  }
  if (selected && view.fcBoardId !== null && view.fcBoardId !== selected.boardId) {
    hard = true; reasons.push(`Board mismatch: flight controller reports board_id ${view.fcBoardId}; selected ${selected.boardId}.`);
  }
  // Auto-match (B2): trusted id+target+mcu, all equal to the selected catalog entry.
  const autoMatched = !!selected && view.fcBoardId === selected.boardId
    && view.fcMcu !== null && view.fcMcu === catalogMcuToken(selected.mcu) && view.fcTarget === view.fcMcu;
  const needsConfirm = !hard && !!selected && (dfu || !autoMatched);
  if (needsConfirm && !manualConfirmed) reasons.push("Manual board selection: confirm the board is correct.");
  return { blocked: hard || (needsConfirm && !manualConfirmed), needsConfirm, reasons, hexMarker: "unknown" };
}
