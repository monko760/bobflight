/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Motor direction on the FC (`motor_direction`, FW schema 10). Pure logic, no
 * React, so it runs under Node tests.
 *
 * Review bar: what the FC holds and its `mixer` report are shown exactly as
 * sent ("unknown" when missing or malformed, future tokens verbatim); every
 * set is followed by `get motor_direction` and then `mixer` (no optimistic
 * update); a refused set returns the FC line verbatim and the re-read value.
 * Only `props-out` / `props-in` are ever sent.
 *
 * Busy gate (QA #60, same rule as filters/rpmFilter.ts): the shared
 * CommandGate refuses, never queues, a command while another is in flight
 * (e.g. the Motors-tab eRPM poll). That refusal happens before anything is
 * sent, so it is the ONLY outcome retried, up to MOTOR_DIRECTION_GATE_ATTEMPTS
 * tries MOTOR_DIRECTION_GATE_DELAY_MS apart. An FC reply (a `set failed` line,
 * a malformed value, "unknown key") or any other error is never retried, so an
 * accepted set is never sent again. Still refused after the last try: the read
 * is `busy` (shown "unknown" with the gate's message, never malformed or
 * "older FC") and the `mixer` report is not read; a `mixer` report still
 * refused after the last try is kept as `reportBusy` (cells "unknown" plus the
 * gate's message; still not "older FC"); a set returns the gate's
 * message like any other error. An aborted `signal` (unmount, newer read)
 * stops the retries: MotorDirectionCancelled is thrown and nothing more is sent.
 */
import {
  motorDirectionSetCommand, parseMixerReport, parseMotorDirectionGetReply, parseMotorDirectionSetReply,
  type MixerReport, type MotorDirectionGetResult, type MotorDirectionOption,
} from "../protocol";
import type { CliCommand } from "../protocol/types";
import { isGateBusy } from "../protocol/commandGate";

export interface MotorDirectionHost {
  sendCommand(cmd: CliCommand): Promise<string>;
  onStatus?(cb: (s: string) => void): () => void;
  getConnectionStatus?(): string;
}
/** A `get motor_direction` result, or `busy`: the command gate stayed busy for every try, so nothing was read. */
export type MotorDirectionReadResult = MotorDirectionGetResult | { kind: "busy"; message: string };
export interface MotorDirectionSnapshot {
  get: MotorDirectionReadResult | null;
  report: MixerReport | null;
  /** The gate's message when the `mixer` report was not read because the gate stayed busy. */
  reportBusy?: string;
}
/** The gate's message when the value or the report was not read because the gate stayed busy. */
export function motorDirectionBusyMessage(snap: MotorDirectionSnapshot): string | null {
  return snap.get?.kind === "busy" ? snap.get.message : snap.reportBusy ?? null;
}
export const emptyMotorDirection = (): MotorDirectionSnapshot => ({ get: null, report: null });
/** What the protocol view may see: a `busy` read was not read at all, so the view treats it as no reading
 * (held "unknown", supported unknown: nothing can be set, and it is never the older-FC state). */
export const viewGet = (r: MotorDirectionReadResult | null): MotorDirectionGetResult | null => (r?.kind === "busy" ? null : r);

export const MOTOR_DIRECTION_GATE_ATTEMPTS = 30;
export const MOTOR_DIRECTION_GATE_DELAY_MS = 100;
/** The caller's signal aborted while a command was waiting for the gate: nothing more is sent. */
export class MotorDirectionCancelled extends Error {
  constructor() { super("motor_direction command cancelled"); this.name = "MotorDirectionCancelled"; }
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
/** One command; retries only the gate's own refusal (nothing was sent), at most MOTOR_DIRECTION_GATE_ATTEMPTS tries. */
async function gated(host: MotorDirectionHost, cmd: CliCommand, signal?: AbortSignal): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new MotorDirectionCancelled();
    try {
      return await host.sendCommand(cmd);
    } catch (e) {
      if (!isGateBusy(e) || attempt >= MOTOR_DIRECTION_GATE_ATTEMPTS) throw e;
    }
    await pause(MOTOR_DIRECTION_GATE_DELAY_MS, signal);
  }
}
/** Reply text, or the error message (FC refusal lines arrive as errors on some hosts); gate-busy kept apart. */
async function send(host: MotorDirectionHost, cmd: CliCommand, signal?: AbortSignal): Promise<{ text: string; busy: boolean }> {
  try { return { text: await gated(host, cmd, signal), busy: false }; } catch (e) {
    if (e instanceof MotorDirectionCancelled) throw e;
    return { text: e instanceof Error ? e.message : String(e), busy: isGateBusy(e) };
  }
}
/** `get motor_direction`, then the `mixer` report (skipped on an older FC or a busy gate). */
export async function readMotorDirection(host: MotorDirectionHost, ops?: string[], signal?: AbortSignal): Promise<MotorDirectionSnapshot> {
  ops?.push("get motor_direction");
  const g = await send(host, "get motor_direction", signal);
  const get: MotorDirectionReadResult = g.busy ? { kind: "busy", message: g.text } : parseMotorDirectionGetReply(g.text);
  if (get.kind === "unsupported" || get.kind === "busy") return { get, report: null };
  ops?.push("mixer");
  const m = await send(host, "mixer", signal);
  return m.busy ? { get, report: null, reportBusy: m.text } : { get, report: parseMixerReport(m.text) };
}

export type MotorDirectionApplyResult = { ok: boolean; fcLine: string | null; ops: string[]; snap: MotorDirectionSnapshot };
/** `set motor_direction <token>` -> `get motor_direction` -> `mixer`. A refusal keeps the FC line verbatim. */
export async function applyMotorDirection(host: MotorDirectionHost, token: MotorDirectionOption, signal?: AbortSignal): Promise<MotorDirectionApplyResult> {
  const cmd = motorDirectionSetCommand(token);
  const ops: string[] = [cmd];
  const res = parseMotorDirectionSetReply((await send(host, cmd, signal)).text, token);
  const snap = await readMotorDirection(host, ops, signal);
  return { ok: res.ok, fcLine: res.ok ? null : res.line, ops, snap };
}
