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
 *
 * #63 Config Lead item 4: only a reply the FC actually sent can fill the
 * refusal slot (`fcLine`). The gate's refusal after the last try (`busy`) and
 * any client/transport error (timeout, "not connected", an empty reply) are a
 * separate `problem`, shown apart from FC refusals. A `get` that failed the
 * same way is `busy` / `error`, never "malformed" and never "older FC".
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
/** A `get motor_direction` result; `busy`: the command gate stayed busy for every try; `error`: the
 * client failed (timeout, not connected). Neither of the last two is an FC reply. */
export type MotorDirectionReadResult =
  | MotorDirectionGetResult
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string };
export interface MotorDirectionSnapshot {
  get: MotorDirectionReadResult | null;
  report: MixerReport | null;
  /** The gate's message when the `mixer` report was not read because the gate stayed busy. */
  reportBusy?: string;
  /** The client's error when the `mixer` report failed (not an FC reply). */
  reportError?: string;
}
/** The gate's message when the value or the report was not read because the gate stayed busy. */
export function motorDirectionBusyMessage(snap: MotorDirectionSnapshot): string | null {
  return snap.get?.kind === "busy" ? snap.get.message : snap.reportBusy ?? null;
}
/** The client's error when the value or the report could not be read (not an FC reply). */
export function motorDirectionErrorMessage(snap: MotorDirectionSnapshot): string | null {
  return snap.get?.kind === "error" ? snap.get.message : snap.reportError ?? null;
}
export const emptyMotorDirection = (): MotorDirectionSnapshot => ({ get: null, report: null });
/** What the protocol view may see: a `busy` / `error` read was not an FC reply, so the view treats it as no
 * reading (held "unknown", supported unknown: nothing can be set, and it is never the older-FC state). */
export const viewGet = (r: MotorDirectionReadResult | null): MotorDirectionGetResult | null =>
  (r?.kind === "busy" || r?.kind === "error" ? null : r);

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
/** The FC's reply text, or why there is none: the gate stayed busy, or the client failed. */
type Sent = { kind: "reply"; text: string } | { kind: "busy"; message: string } | { kind: "error"; message: string };
async function send(host: MotorDirectionHost, cmd: CliCommand, signal?: AbortSignal): Promise<Sent> {
  try { return { kind: "reply", text: await gated(host, cmd, signal) }; } catch (e) {
    if (e instanceof MotorDirectionCancelled) throw e;
    const message = e instanceof Error ? e.message : String(e);
    return isGateBusy(e) ? { kind: "busy", message } : { kind: "error", message };
  }
}
/** `get motor_direction`, then the `mixer` report (skipped on an older FC, a busy gate or a client error). */
export async function readMotorDirection(host: MotorDirectionHost, ops?: string[], signal?: AbortSignal): Promise<MotorDirectionSnapshot> {
  ops?.push("get motor_direction");
  const g = await send(host, "get motor_direction", signal);
  const get: MotorDirectionReadResult = g.kind === "reply" ? parseMotorDirectionGetReply(g.text) : g;
  if (get.kind !== "value" && get.kind !== "malformed") return { get, report: null };
  ops?.push("mixer");
  const m = await send(host, "mixer", signal);
  if (m.kind === "busy") return { get, report: null, reportBusy: m.message };
  if (m.kind === "error") return { get, report: null, reportError: m.message };
  return { get, report: parseMixerReport(m.text) };
}

/** Why a set got no FC reply: the gate stayed busy (never sent) or the client failed (may or may not have reached the FC). */
export type MotorDirectionProblem = { kind: "busy" | "error"; message: string };
export type MotorDirectionApplyResult = {
  ok: boolean;
  /** The FC's refusal line verbatim; only ever an FC reply. */
  fcLine: string | null;
  /** No FC reply to the set (gate busy / client error / empty reply); never shown as an FC refusal. */
  problem: MotorDirectionProblem | null;
  ops: string[];
  snap: MotorDirectionSnapshot;
};
/** No text at all in reply to a set: not an FC refusal. */
export const MOTOR_DIRECTION_NO_REPLY = "no reply text from the controller";
/** `set motor_direction <token>` -> `get motor_direction` -> `mixer` (always re-read, also after a problem). */
export async function applyMotorDirection(host: MotorDirectionHost, token: MotorDirectionOption, signal?: AbortSignal): Promise<MotorDirectionApplyResult> {
  const cmd = motorDirectionSetCommand(token);
  const ops: string[] = [cmd];
  const sent = await send(host, cmd, signal);
  let ok = false, fcLine: string | null = null, problem: MotorDirectionProblem | null = null;
  if (sent.kind === "reply") {
    const res = parseMotorDirectionSetReply(sent.text, token);
    if (res.ok) ok = true;
    else if (res.line === null) problem = { kind: "error", message: MOTOR_DIRECTION_NO_REPLY };
    else fcLine = res.line;
  } else problem = sent;
  const snap = await readMotorDirection(host, ops, signal);
  return { ok, fcLine, problem, ops, snap };
}
