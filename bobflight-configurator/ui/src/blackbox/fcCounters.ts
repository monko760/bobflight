/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Recorder and loop counters exactly as the FC sent them (no math, no
 * parsing to numbers). A key that is missing, empty or repeated in the reply
 * is "unknown"; any other token (including values the Configurator does not
 * know) is shown as-is.
 */
export const BLACKBOX_COUNTER_KEYS = [
  'blackbox_frames',
  'blackbox_dropped',
  'blackbox_missed',
  'blackbox_invalid',
  'blackbox_queue',
  'blackbox_drop_pct',
  'blackbox_rate_hz',
  'blackbox_rate_requested_hz',
  'blackbox_rate_reason',
] as const;
/** From the `status` reply. */
export const STATUS_COUNTER_KEYS = ['loop_overruns'] as const;
export const COUNTER_UNKNOWN = 'unknown';

export interface CounterRow { key: string; value: string }

export function verbatimCounters(raw: string | null | undefined, keys: readonly string[]): CounterRow[] {
  const seen = new Map<string, string[]>();
  for (const line of String(raw ?? '').split(/\r\n|\n|\r/)) {
    const m = /^([a-z0-9_]+):(.*)$/.exec(line.trim());
    if (!m || !keys.includes(m[1])) continue;
    seen.set(m[1], [...(seen.get(m[1]) ?? []), m[2].trim()]);
  }
  return keys.map((key) => {
    const values = seen.get(key);
    return { key, value: values && values.length === 1 && values[0] !== '' ? values[0] : COUNTER_UNKNOWN };
  });
}
