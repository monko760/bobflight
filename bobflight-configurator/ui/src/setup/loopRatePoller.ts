/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Setup loop-rate poll of read-only `status`, adapted from the Configurator
 * Lead's TimingPoller (epoch-based stale drop, one request in flight, idle()).
 *
 * The reading stays local to the Setup loop-rate readout. It never updates
 * the shared useHost `status` and never feeds any StoragePanel `blocked`
 * (the Motors flicker lock from PR #54 stays exactly as it is).
 */
export const LOOP_RATE_POLL_MS = 1000;
/** Shared-gate refusals in a row before the old reading is dropped as stale (~3 s). */
export const LOOP_RATE_MAX_SKIPS = 3;

/** Raw `status` reply (parse with parseLoopStatus); null = no current reading. */
export interface LoopRatePollState { raw: string | null; error: string }
export interface PollTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const browserTimers: PollTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Polls only while enabled (connected, no Setup action, no post-flash gate).
 * One request at a time, never queued; replies from an older enable epoch are
 * dropped. A shared-gate "in flight / not queued" refusal is transient and
 * keeps the last reading for up to LOOP_RATE_MAX_SKIPS polls, then the
 * reading is cleared so a stale rate is never shown as current.
 */
export class LoopRatePoller {
  state: LoopRatePollState = { raw: null, error: "" };
  private enabled = false;
  private epoch = 0;
  private skips = 0;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  constructor(
    private send: () => Promise<string>,
    private onChange: (state: LoopRatePollState) => void = () => {},
    private timers: PollTimers = browserTimers,
  ) {}
  get isEnabled(): boolean { return this.enabled; }
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.epoch++;
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    if (enabled) void this.poll(this.epoch);
  }
  /** Disconnected: drop the old reading so stale numbers are never shown. */
  reset(): void { this.skips = 0; this.patch({ raw: null, error: "" }); }
  /** Resolves once any in-flight `status` request has settled (await before a page action). */
  idle(): Promise<void> { return this.inFlight ?? Promise.resolve(); }
  private patch(next: LoopRatePollState): void { this.state = next; this.onChange(next); }
  private async poll(epoch: number): Promise<void> {
    if (!this.enabled || epoch !== this.epoch) return;
    if (!this.inFlight) {
      const request = this.send().then(raw => {
        if (epoch !== this.epoch) return;
        this.skips = 0;
        this.patch({ raw, error: "" });
      }, e => {
        if (epoch !== this.epoch) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/in flight|not queued/i.test(msg)) {
          if (++this.skips >= LOOP_RATE_MAX_SKIPS && this.state.raw !== null) this.patch({ raw: null, error: "" });
        } else {
          this.skips = 0;
          this.patch({ raw: null, error: msg });
        }
      }).finally(() => { if (this.inFlight === request) this.inFlight = null; });
      this.inFlight = request;
      await request;
    }
    if (this.enabled && epoch === this.epoch) this.timer = this.timers.set(() => void this.poll(epoch), LOOP_RATE_POLL_MS);
  }
}
