/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import type { BobFlightHost, ConnectionStatus, ParsedStatus } from "./types";

export interface CanUnlockParams {
  host: BobFlightHost;
  connectionStatus: ConnectionStatus;
  expectedBoardId: string | undefined | null;
  version: string | null;
  status: ParsedStatus | null;
  pollConnectionGen: number;
  currentConnectionGen: number;
  pollFlashGen: number;
  currentFlashGen: number;
}

/**
 * Validates whether the post-flash gate can be safely unlocked.
 *
 * Criteria:
 * - Connection & flash generations must match (discards results crossing disconnect/reconnect/new flash).
 * - Host must be currently connected and in a LIVE state (host.isLiveConnection?() === true).
 * - expectedBoardId must be a non-empty string.
 * - version must be a non-empty string.
 * - status must be non-null and status.board must match expectedBoardId.
 */
export function canUnlockPostFlashGate(params: CanUnlockParams): boolean {
  const {
    host,
    connectionStatus,
    expectedBoardId,
    version,
    status,
    pollConnectionGen,
    currentConnectionGen,
    pollFlashGen,
    currentFlashGen,
  } = params;

  if (pollConnectionGen !== currentConnectionGen) return false;
  if (pollFlashGen !== currentFlashGen) return false;

  if (connectionStatus !== "connected") return false;
  if (host.getConnectionStatus() !== "connected") return false;
  if (!host.isLiveConnection || !host.isLiveConnection()) return false;

  if (typeof expectedBoardId !== "string" || expectedBoardId.trim().length === 0) {
    return false;
  }

  if (typeof version !== "string" || version.trim().length === 0) {
    return false;
  }

  if (!status || typeof status.board !== "string" || status.board.trim().length === 0) {
    return false;
  }

  return status.board.trim().toLowerCase() === expectedBoardId.trim().toLowerCase();
}
