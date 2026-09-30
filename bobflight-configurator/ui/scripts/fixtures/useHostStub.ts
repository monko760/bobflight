/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Test stub for ../hooks/useHost (swapped in by run-setup-loop-poll.mjs): the test owns the context value. */
export function useHost(): any {
  const ctx = (globalThis as { __setupTestHost?: unknown }).__setupTestHost;
  if (!ctx) throw new Error("useHost stub: __setupTestHost not set");
  return ctx;
}
