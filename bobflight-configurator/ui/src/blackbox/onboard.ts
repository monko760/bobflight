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

export interface OnboardSnapshot {
  api: number;
  state: OnboardState | 'unavailable';
  reason: string;
  file: string;
  bytes: number;
  frames: number;
  rateHz: number;
  dropped: number;
  missed: number;
  invalid: number;
  queue: number;
  active: boolean;
  unavailable: boolean;
  raw: string;
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
    rateHz: 500,
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

  const requiredFields = [
    'blackbox_api',
    'blackbox_state',
    'blackbox_reason',
    'blackbox_file',
    'blackbox_bytes',
    'blackbox_frames',
    'blackbox_rate_hz',
    'blackbox_dropped',
    'blackbox_missed',
    'blackbox_invalid',
    'blackbox_queue',
    'blackbox_active',
    'blackbox_end',
  ];

  if (
    fields.blackbox_end !== '1' ||
    fields.blackbox_api !== '1' ||
    !ONBOARD_STATES.includes(fields.blackbox_state as OnboardState) ||
    (fields.blackbox_active !== '0' && fields.blackbox_active !== '1')
  ) {
    throw new Error(
      'Incomplete or unsupported blackbox reply. Firmware with blackbox:1 support is required.'
    );
  }

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

  const expectedActive=['initializing','preparing','writing-header','recording','draining','closing'].includes(fields.blackbox_state);
  if(expectedActive !== (fields.blackbox_active==='1') || uint('blackbox_rate_hz')!==500 || uint('blackbox_queue')>64 || !/^(BFL\d{5}\.BBL)?$/.test(fields.blackbox_file))throw new Error('Inconsistent Blackbox state or metadata.');
  return {
    api: Number(fields.blackbox_api),
    state: fields.blackbox_state as OnboardState,
    reason: fields.blackbox_reason || '',
    file: fields.blackbox_file || '',
    bytes: uint('blackbox_bytes'),
    frames: uint('blackbox_frames'),
    rateHz: uint('blackbox_rate_hz'),
    dropped: uint('blackbox_dropped'),
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
