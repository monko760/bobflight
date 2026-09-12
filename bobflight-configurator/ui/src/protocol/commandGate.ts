/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Shared across UI pages. Never queue a motor start (or any ordinary command).
 * Only Stop may wait for the active transaction; while waiting it owns priority.
 * The connection generation prevents queued Stops crossing USB sessions.
 */
export class CommandGate {
  private active: Promise<unknown> | null = null;
  constructor(private session: () => number) {}
  run<T>(work: () => Promise<T>, stop = false): Promise<T> {
    if (this.active && !stop) return Promise.reject(new Error("another UI command is in flight; request not queued"));
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
