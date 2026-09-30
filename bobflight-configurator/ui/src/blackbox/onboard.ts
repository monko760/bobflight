/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import type { Link } from './recorder';

export const ONBOARD_COMMANDS = ['blackbox start', 'blackbox stop', 'blackbox status'] as const;
export type OnboardCommand = (typeof ONBOARD_COMMANDS)[number];

export const ONBOARD_STATES = [
  'initializing',
  'idle',
  'preparing',
  'writing-header',
  'recording',
  'draining',
  'closing',
  'done',
  'error',
] as const;

export type OnboardState = (typeof ONBOARD_STATES)[number];

/** Rates the firmware can log at (125 is the auto-lower floor). */
export const ONBOARD_RATES_HZ = [125, 250, 500, 1000] as const;
/** Documented `blackbox_rate_reason` values (firmware api 2). */
export const ONBOARD_RATE_REASONS = ['default', 'auto-lowered-card-slow'] as const;
export type OnboardRateReason = (typeof ONBOARD_RATE_REASONS)[number];
/** Firmware recorder FIFO capacity (samples). */
export const ONBOARD_QUEUE_CAPACITY = 64;
/** Shown for any value the FC did not report. Never replaced by 0 or 500. */
export const ONBOARD_UNKNOWN = 'unknown';

export interface OnboardSnapshot {
  api: number;
  state: OnboardState | 'unavailable';
  reason: string;
  file: string;
  bytes: number;
  frames: number;
  /** Effective logging rate as reported in `blackbox_rate_hz`; null = not reported. */
  rateHz: number | null;
  /** `blackbox_rate_requested_hz` (api 2); null = not reported (api 1 or missing). */
  requestedHz: number | null;
  /** `blackbox_rate_reason` (api 2); null = not reported (api 1 or missing). */
  rateReason: OnboardRateReason | string | null;
  /** `blackbox_drop_pct` exactly as the FC sent it (e.g. "85.2"); never computed
   * by the Configurator. null = not reported (api 1 or missing). */
  dropPct: string | null;
  dropped: number;
  missed: number;
  invalid: number;
  queue: number;
  active: boolean;
  unavailable: boolean;
  raw: string;
}

export function formatOnboardHz(hz: number | null): string {
  return hz === null ? ONBOARD_UNKNOWN : `${hz} Hz`;
}

/** FC-sent percent string, verbatim, or "unknown". */
export function formatOnboardDropPct(pct: string | null): string {
  return pct === null ? ONBOARD_UNKNOWN : `${pct}%`;
}

export function formatOnboardRateReason(reason: string | null): string {
  return reason === null ? ONBOARD_UNKNOWN : reason;
}

/** True only when the FC explicitly reports the card-slow auto-lower. */
export function onboardAutoLowered(s: Pick<OnboardSnapshot, 'rateReason'>): boolean {
  return s.rateReason === 'auto-lowered-card-slow';
}

/** Effective rate; the auto-lowered note appears only for that reported reason. */
export function describeOnboardRate(s: Pick<OnboardSnapshot, 'rateHz' | 'requestedHz' | 'rateReason'>): string {
  const rate = formatOnboardHz(s.rateHz);
  if (onboardAutoLowered(s)) {
    return `${rate} (requested ${formatOnboardHz(s.requestedHz)}; auto-lowered because the SD card could not keep up)`;
  }
  return rate;
}

/** "N dropped (P%)" with the FC's own percent string, or "(unknown)". */
export function describeOnboardDrops(s: Pick<OnboardSnapshot, 'dropped' | 'dropPct'>): string {
  return `${s.dropped.toLocaleString('en-US')} dropped (${formatOnboardDropPct(s.dropPct)})`;
}

export function parseOnboardReply(raw: string): OnboardSnapshot {
  if (raw.length > 8192) {
    throw new Error('Blackbox reply exceeds size limit.');
  }

  const blankDefaults = {
    api: 1,
    reason: '',
    file: '',
    bytes: 0,
    frames: 0,
    rateHz: null,
    requestedHz: null,
    rateReason: null,
    dropPct: null,
    dropped: 0,
    missed: 0,
    invalid: 0,
    queue: 0,
  };

  if (
    /(^|\n)(unknown\b|blackbox unavailable:)/i.test(raw) ||
    /blackbox_state:\s*unavailable-mock/.test(raw)
  ) {
    return {
      ...blankDefaults,
      state: 'unavailable',
      reason: raw.trim(),
      active: false,
      unavailable: true,
      raw,
    };
  }

  if (/(^|\n)blackbox refused:/.test(raw)) {
    const line = raw.split(/\r?\n/).find((x) => x.startsWith('blackbox refused:'));
    throw new Error(line || 'blackbox refused');
  }

  if(raw.trimEnd().split(/\r?\n/).at(-1)!=='blackbox_end: 1')throw new Error('Missing final blackbox terminator.');
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(blackbox_[a-z_]+):\s*(.*?)\s*$/.exec(line.trim());
    if (!match) continue;
    // Unknown fields safe: ignore non-standard fields.
    if(Object.hasOwn(fields,match[1]))throw new Error('Duplicate Blackbox field: '+match[1]);
    fields[match[1]]=match[2];
  }

  const requiredFields: string[] = [
    'blackbox_api',
    'blackbox_state',
    'blackbox_reason',
    'blackbox_file',
    'blackbox_bytes',
    'blackbox_frames',
    'blackbox_dropped',
    'blackbox_missed',
    'blackbox_invalid',
    'blackbox_queue',
    'blackbox_active',
    'blackbox_end',
  ];

  if (
    fields.blackbox_end !== '1' ||
    (fields.blackbox_api !== '1' && fields.blackbox_api !== '2') ||
    !ONBOARD_STATES.includes(fields.blackbox_state as OnboardState) ||
    (fields.blackbox_active !== '0' && fields.blackbox_active !== '1')
  ) {
    throw new Error(
      'Incomplete or unsupported blackbox reply. Firmware with blackbox api 1 or 2 support is required.'
    );
  }

  const api = Number(fields.blackbox_api);
  for (const req of requiredFields) {
    if (!Object.hasOwn(fields, req)) {
      throw new Error(
        'Incomplete or unsupported blackbox reply. Missing required field: ' + req
      );
    }
  }

  const uint = (key: string): number => {
    const val = fields[key];
    if (val === undefined || !/^\d+$/.test(val) || !Number.isSafeInteger(Number(val))) {
      throw new Error(`Invalid numeric field ${key} in blackbox reply.`);
    }
    return Number(val);
  };
  const isRate = (hz: number) => (ONBOARD_RATES_HZ as readonly number[]).includes(hz);
  /** A reported rate must be a supported rate; a missing one stays null ("unknown"). */
  const optionalRate = (key: string): number | null => {
    if (!Object.hasOwn(fields, key)) return null;
    const hz = uint(key);
    if (!isRate(hz)) throw new Error(`Unsupported ${key} in blackbox reply.`);
    return hz;
  };

  const expectedActive=['initializing','preparing','writing-header','recording','draining','closing'].includes(fields.blackbox_state);
  const rateHz = optionalRate('blackbox_rate_hz');
  // api 1 firmware only ever logged at a fixed 500 Hz; anything else is malformed.
  if(expectedActive !== (fields.blackbox_active==='1') || (api === 1 && rateHz !== null && rateHz !== 500) || uint('blackbox_queue')>ONBOARD_QUEUE_CAPACITY || !/^(BFL\d{5}\.BBL)?$/.test(fields.blackbox_file))throw new Error('Inconsistent Blackbox state or metadata.');
  const frames = uint('blackbox_frames');
  const dropped = uint('blackbox_dropped');
  // api 1 FCs do not report these: they stay null and render as "unknown".
  // Nothing is inferred, defaulted or computed by the Configurator.
  let requestedHz: number | null = null;
  let rateReason: OnboardRateReason | string | null = null;
  let dropPct: string | null = null;
  if (api >= 2) {
    requestedHz = optionalRate('blackbox_rate_requested_hz');
    if (Object.hasOwn(fields, 'blackbox_rate_reason')) {
      const reason = fields.blackbox_rate_reason;
      // Documented reasons are typed; a future documented token is shown verbatim.
      if (!/^[a-z0-9-]{1,40}$/.test(reason)) {
        throw new Error('Invalid blackbox_rate_reason in blackbox reply.');
      }
      rateReason = reason;
    }
    if (Object.hasOwn(fields, 'blackbox_drop_pct')) {
      const pct = fields.blackbox_drop_pct;
      if (!/^\d{1,3}\.\d$/.test(pct) || Number(pct) > 100) {
        throw new Error('Invalid blackbox_drop_pct in blackbox reply.');
      }
      dropPct = pct; // displayed verbatim, never recomputed
    }
    // Consistency is checked only between values the FC actually reported.
    if (rateHz !== null && requestedHz !== null) {
      if (rateHz > requestedHz || (rateReason === 'default' && rateHz !== requestedHz) || (rateReason === 'auto-lowered-card-slow' && rateHz >= requestedHz)) {
        throw new Error('Inconsistent Blackbox rate metadata.');
      }
    }
  }
  return {
    api,
    state: fields.blackbox_state as OnboardState,
    reason: fields.blackbox_reason || '',
    file: fields.blackbox_file || '',
    bytes: uint('blackbox_bytes'),
    frames,
    rateHz,
    requestedHz,
    rateReason,
    dropPct,
    dropped,
    missed: uint('blackbox_missed'),
    invalid: uint('blackbox_invalid'),
    queue: uint('blackbox_queue'),
    active: fields.blackbox_active === '1',
    unavailable: false,
    raw,
  };
}

/** Explicit user actions only for start/stop.
 * Auto-polls status at 1Hz when visible and connected.
 * Never autoStops on tab hide/USB disconnect (physical FC continues recording). */
export class OnboardController {
  snapshot: OnboardSnapshot | null = null;
  error = '';
  pending = false;
  private enabled = false;
  private epoch = 0;
  private nextPoll = 0;

  constructor(
    private link: Link,
    private now = () => performance.now()
  ) {}

  get active(): boolean {
    return this.snapshot ? this.snapshot.active : false;
  }

  get busy(): boolean {
    return this.pending || this.active;
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.epoch++;
    this.pending = false;
    this.snapshot = null;
    this.error = '';
    this.nextPoll = 0;
  }

  async command(cmd: OnboardCommand): Promise<boolean> {
    if (
      !this.enabled ||
      this.pending ||
      !ONBOARD_COMMANDS.includes(cmd) ||
      this.link.getConnectionStatus() !== 'connected'
    ) {
      return false;
    }
    const token = this.epoch;
    this.pending = true;
    this.nextPoll=this.now()+1000;
    this.error = '';
    try {
      const raw = await this.link.sendCommand(cmd);
      if (!this.enabled || token !== this.epoch || this.link.getConnectionStatus() !== 'connected') {
        return false;
      }
      const snapshot = parseOnboardReply(raw);
      this.snapshot = snapshot;
      this.nextPoll = this.now() + 1000;
      return true;
    } catch (e) {
      if (this.enabled && token === this.epoch) {
        this.error = String(e).slice(0, 1000);
      }
      return false;
    } finally {
      if (token === this.epoch) {
        this.pending = false;
      }
    }
  }

  async tick() {
    if (!this.enabled || this.pending) return;
    if (this.link.getConnectionStatus() !== 'connected') {
      this.setEnabled(false);
      return;
    }
    if (this.now() >= this.nextPoll) {
      await this.command('blackbox status');
    }
  }
}
