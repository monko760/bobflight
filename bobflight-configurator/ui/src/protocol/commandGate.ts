/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** The gate's refusal. It is raised before `work` runs, so nothing reached the FC. */
export const GATE_BUSY_MESSAGE = "another UI command is in flight; request not queued";
/** True only for the gate's own refusal (exact message), never for an FC reply or a transport error. */
export function isGateBusy(e: unknown): boolean {
  return e instanceof Error && e.message === GATE_BUSY_MESSAGE;
}
/** Shared across UI pages. Never queue a motor start (or any ordinary command).
 * Only Stop may wait for the active transaction; while waiting it owns priority.
 * The connection generation prevents queued Stops crossing USB sessions.
 */
export class CommandGate {
  private active: Promise<unknown> | null = null;
  constructor(private session: () => number) {}
  run<T>(work: () => Promise<T>, stop = false): Promise<T> {
    if (this.active && !stop) return Promise.reject(new Error(GATE_BUSY_MESSAGE));
    const generation = this.session();
    const previous = this.active;
    const p = Promise.resolve(stop ? previous : undefined).catch(() => {}).then(() => {
      if (generation !== this.session()) throw new Error("USB session changed; request cancelled");
      return work();
    }).finally(() => { if (this.active === p) this.active = null; });
    this.active = p;
    return p;
  }
}
