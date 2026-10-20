/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * Board auto-detect from firmware `version` (board_id / board_target / board_mcu).
 * - Read through the shared CommandGate with the readRpm retry budget (30 x 100 ms).
 *   A gate that stays busy shows `unknown` with the gate's message: never "older firmware".
 * - Tokens are shown verbatim; a missing key shows `unknown`; a malformed value shows
 *   `unknown (<verbatim>)` and is never trusted for selection or matching.
 * - No arithmetic on FC-derived values. Nothing here feeds the StoragePanel.
 */
import { parseBoardIdentity, boardIdFieldText, type BoardIdentity } from "@bobflight/protocol";
import { gated, RpmCancelled } from "../filters/rpmFilter";
import { isGateBusy } from "../protocol/commandGate";
import { BOARD_OPTIONS, normalizeMcu, type BoardOption } from "./types";

export type IdentityRead =
  | { kind: "idle" }
  | { kind: "read"; identity: BoardIdentity }
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string };

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
  /** Valid tokens only; null when unknown, missing, malformed, busy or not read. */
  fcBoardId: string | null; fcMcu: string | null;
  /** Catalog board to pre-select, only for a valid board_id that is in the catalog. */
  preselect: string | null;
  note: string | null;
}

export function identityView(read: IdentityRead, options: readonly BoardOption[] = BOARD_OPTIONS): IdentityView {
  const blank = { boardId: "unknown", target: "unknown", mcu: "unknown", fcBoardId: null, fcMcu: null, preselect: null };
  if (read.kind === "idle") return { ...blank, note: "Connect the flight controller to read its board identity, or select the board manually." };
  if (read.kind === "busy") return { ...blank, note: `Board identity not read (${read.message}). Select the board manually.` };
  if (read.kind === "error") return { ...blank, note: `Board identity not read (${read.message}). Select the board manually.` };
  const { board_id, board_target, board_mcu } = read.identity;
  const fcBoardId = board_id.kind === "value" ? board_id.token : null;
  const fcMcu = board_mcu.kind === "value" ? board_mcu.token : null;
  const inCatalog = fcBoardId !== null && options.some((b) => b.boardId === fcBoardId);
  const note = board_id.kind === "missing"
    ? "Firmware does not report board_id (older firmware). Select the board manually."
    : board_id.kind === "malformed"
      ? "Firmware board_id is not a valid token and is not trusted. Select the board manually."
      : !inCatalog
        ? `Board ${fcBoardId} is not in this Configurator's catalog. Nothing pre-selected.`
        : null;
  return {
    boardId: boardIdFieldText(board_id), target: boardIdFieldText(board_target), mcu: boardIdFieldText(board_mcu),
    fcBoardId, fcMcu, preselect: inCatalog ? fcBoardId : null, note,
  };
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
export function identityGate(view: IdentityView, selected: BoardOption | undefined, hexMcu: string | null | undefined, manualConfirmed: boolean): IdentityGate {
  const reasons: string[] = [];
  let hard = false;
  if (selected && view.fcMcu !== null) {
    const want = catalogMcuToken(selected.mcu);
    if (want !== view.fcMcu) { hard = true; reasons.push(`MCU mismatch: flight controller reports board_mcu ${view.fcMcu}; selected board ${selected.boardId} is ${selected.mcuDisplay}.`); }
  }
  if (view.fcMcu !== null && hexMcu) {
    const hex = catalogMcuToken(hexMcu);
    if (hex !== null && hex !== view.fcMcu) { hard = true; reasons.push(`MCU mismatch: flight controller reports board_mcu ${view.fcMcu}; firmware file is for ${hexMcu}.`); }
  }
  if (selected && view.fcBoardId !== null && view.fcBoardId !== selected.boardId) {
    hard = true; reasons.push(`Board mismatch: flight controller reports board_id ${view.fcBoardId}; selected ${selected.boardId}.`);
  }
  const autoMatched = !!selected && view.fcBoardId !== null && view.fcBoardId === selected.boardId;
  const needsConfirm = !hard && !!selected && !autoMatched;
  if (needsConfirm && !manualConfirmed) reasons.push("Manual board selection: confirm the board is correct.");
  return { blocked: hard || (needsConfirm && !manualConfirmed), needsConfirm, reasons, hexMarker: "unknown" };
}
