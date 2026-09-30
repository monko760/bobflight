/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import type { BenchState } from "./benchController";

/**
 * StoragePanel `blocked` for the Motors page: only a user-initiated bench
 * action or a stop. Never `busy`: the 500 ms read-only poll toggles busy, and
 * feeding it to StoragePanel reset/refreshed the panel on every poll (flicker).
 */
export function storageBlocked(s: Pick<BenchState, "actionPending" | "stopping">): boolean {
  return s.actionPending || s.stopping;
}
