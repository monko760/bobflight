# DShot R0b — M1 listen-after-TX eRPM smoke plan

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

Props-off field smoke for Kakute F7 HDV bidirectional DShot on **M1 only**
(PB0 / TIM3_CH3 AF2). Host unit tests cover encode + GCR ingest; this note is
the on-target checklist after Lead wires CLI.

## Preconditions

- Props **off** on all motors.
- ESC on M1 speaks bidirectional DShot (BLHeli_32 / similar).
- Flash a Kakute build from `feat/dshot-r0b-m1-erpm` (or merged main).
- Do not enable Filters/RPM notch work in the same flash if separating PRs.

## CLI (Lead wire-up)

Expected Lead mappings onto `dshot_telem.h`:

| CLI | API |
|-----|-----|
| `set dshot_bidir on/off` | `dshot_bidir_set_enabled` |
| `get erpm_m1` | `dshot_m1_erpm` |
| `get dshot_telem_m1` | status / period / age helpers |

## Steps

1. Boot, confirm motors safe/idle.
2. `set dshot_bidir on` (M1 telem request bit set on TX).
3. Bench or low prepared throttle on **M1 only** (existing 35% cap / stop controls).
4. Poll `erpm_m1` / telem status:
   - Expect `OK` + non-zero eRPM when ESC replies with valid GCR.
   - `CRC_FAIL` / `INVALID` / `TIMEOUT` indicate wire/IC/window issues — do not raise throttle.
5. `set dshot_bidir off` → status `NONE`, eRPM 0.
6. Stop motors; remove power before props-on of any kind.

## Pin / DMA lock (do not change TX)

- M1: PB0, AF2, TIM3_CH3
- TX: TIM3_UP DMA1 Stream2 Channel5 (CCR preload) — unchanged
- RX: same pin, TIM3_CH3 input-capture after TX (`hal_tim_ic.c`)

## Open HAL notes

- R0b IC uses post-TX DMA-TC wait + **polled** CC3IF edge collection, then
  restores CH3 PWM. Flight-quality DMA/IRQ IC and precise listen-window timing
  remain follow-ups.
- Host tests do not exercise real TIM; they inject edges / GCR words.
