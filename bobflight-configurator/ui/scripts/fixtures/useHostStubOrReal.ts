/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Test stub for ../hooks/useHost used by run-motor-direction.mjs: the test owns the
 * context value, or sets __setupTestHost = "real" to use the real HostProvider
 * context (real ProtocolHostAdapter from createHost over the protocol MockSerial).
 */
import { useHost as realUseHost } from "../../src/hooks/useHost";
export function useHost(): any {
  const ctx = (globalThis as { __setupTestHost?: unknown }).__setupTestHost;
  if (ctx === "real") return realUseHost();
  if (!ctx) throw new Error("useHost stub: __setupTestHost not set");
  return ctx;
}
