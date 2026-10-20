/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * Which CDC session a board identity came from, and whether a DFU device may inherit it.
 * Config Lead / QA B1: a matched identity may skip the manual confirm ONLY when the DFU
 * device follows an acknowledged `bl` reboot from the same CDC session that reported it.
 * Any other DFU device, a second device selection, or a DFU re-plug: identity unknown.
 * Module state (not React state) so it survives navigating between pages.
 */
import type { IdentityRead } from "./boardIdentity";

let session = 0;
let current: { session: number; read: IdentityRead } | null = null;
let reboot: { session: number } | null = null;

/** HostProvider calls this on every CDC status change. A new connection is a new session. */
export function cdcStatusChanged(status: string): void {
  if (status === "connected") { session++; current = null; reboot = null; }
}
export function currentCdcSession(): number { return session; }
/** Record the identity read during CDC session `s` (ignored if that session has ended). */
export function recordSessionIdentity(s: number, read: IdentityRead): void {
  if (s === session) current = { session: s, read };
}
export function sessionIdentity(): IdentityRead { return current?.read ?? { kind: "idle" }; }
/** CliPage calls this when the firmware acknowledged `bl` during the current session. */
export function noteBootloaderReboot(): void {
  if (current && current.session === session) reboot = { session };
}
/**
 * A DFU device was selected. Returns the identity it may inherit (consumed: one device only),
 * or a `stale` read meaning identity unknown.
 */
export function identityForDfuDevice(): IdentityRead {
  const ok = !!reboot && !!current && reboot.session === current.session && current.session === session;
  reboot = null;
  if (ok) return current!.read;
  current = null;
  return { kind: "stale", message: "DFU device was not reached by a bootloader reboot from the CDC session that reported the board identity" };
}
/** A DFU device disconnected (re-plug): any inherited identity is no longer about this board. */
export function dfuDeviceLost(): IdentityRead {
  reboot = null; current = null;
  return { kind: "stale", message: "DFU device was disconnected; a re-plugged device may be a different board" };
}
/** Test hook. */
export function resetIdentitySession(): void { session = 0; current = null; reboot = null; }
