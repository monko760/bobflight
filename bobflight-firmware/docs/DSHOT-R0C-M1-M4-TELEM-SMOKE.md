# DShot R0c — M1–M4 listen-after-TX eRPM smoke plan

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

Props-off field smoke for Kakute F7 HDV bidirectional DShot on **M1–M4**.
Host unit tests cover encode + GCR ingest for motors 0..3; this note is the
on-target checklist after Lead wires CLI. Flash held until props-off.

## Pin / DMA lock (do not change TX)

| M | Pin | AF | CH | TX DMA |
|---|-----|----|----|--------|
| M1 | PB0 | AF2 | TIM3_CH3 | TIM3_UP DMA1 S2/C5 |
| M2 | PB1 | AF2 | TIM3_CH4 | shared TIM3_UP |
| M3 | PE9 | AF1 | TIM1_CH1 | TIM1_UP DMA2 S5/C6 |
| M4 | PE11 | AF1 | TIM1_CH2 | shared TIM1_UP |

IR: `board-defs/.../kakute_f7_hdv.M1-M4-AF-DMA-LOCK.md` (`ir_verified=false`).

## R0c listen-window sharpen (vs R0b)

- Wait **both** TIM3_UP and TIM1_UP DMA TC before programming any IC (TX starts
  both timers together).
- ~1 ARR settle after TC so the last TX bit period finishes before IC.
- `hal_dshot_ic_collect()` polls all armed CCxIF flags in **one** spin so
  M2–M4 are not starved by sequential `take()` budgets.
- Quiet-gap early exit after edges stop → TIMEOUT without burning full spin.

## Fail / timeout expectations

| Status | Meaning |
|--------|---------|
| OK | Valid GCR → eRPM |
| CRC_FAIL / INVALID | Wire/decode issue — do not raise throttle |
| TIMEOUT | No/insufficient edges in listen window |
| STALE | Age > 100 ms since last OK |
| NONE | bidir off |

## Open HAL questions

- Polled IC is bring-up only; IRQ/DMA IC + tighter window next.
- Settle-after-TC is coarse (CNT delta vs ARR); may need ESC-specific skew.
- GPIO AF left to TX path (AF2 TIM3 / AF1 TIM1) — no remap in IC.
