/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Host-wide "settings storage action in flight" flag (BB2a storage lock).
 * Every flash save, `defaults` restore and `storage` read (the StoragePanel
 * refresh, and the reads around its Save) is tracked here, whichever page
 * started it. Pages that must not start SD work meanwhile (Blackbox Download)
 * read `pending` and re-render on `subscribe`.
 *
 * A short trailing hold keeps the flag set between the commands of one
 * StoragePanel sequence (`storage` -> `save` -> `storage`), so nothing can
 * slip in between them.
 */
export const STORAGE_ACTIVITY_HOLD_MS = 400;

export class StorageActivity {
  private active = 0;
  private holdUntil = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly holdMs = STORAGE_ACTIVITY_HOLD_MS, private readonly now: () => number = () => Date.now()) {}

  /** True while a storage action runs, and for `holdMs` after the last one ended. */
  get pending(): boolean {
    return this.active > 0 || this.now() < this.holdUntil;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch { /* a listener must not break the host */ }
    }
  }

  /** Runs one storage action; the flag is set before it starts and cleared (after the hold) when it settles. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const was = this.pending;
    this.active++;
    if (!was) this.emit();
    try {
      return await work();
    } finally {
      this.active--;
      if (this.active === 0) {
        this.holdUntil = this.now() + this.holdMs;
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => { this.holdTimer = null; this.holdUntil = 0; if (this.active === 0) this.emit(); }, this.holdMs);
        (this.holdTimer as { unref?: () => void }).unref?.();
      }
    }
  }
}

/** CLI lines that are settings storage actions (sent through `sendCommand`). */
export function isStorageCommand(cmd: string): boolean {
  return cmd === "storage" || cmd === "save" || cmd === "defaults";
}
