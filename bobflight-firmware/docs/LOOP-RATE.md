# Loop rate: Kakute F7 HDV 4 kHz PID, status keys, fallbacks

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Scope

PR #43 shipped PID R0–R2 only. Its "R3 4 kHz" item was left for a follow-up and
no 4 kHz commit exists on any branch. This change is that follow-up:

- Kakute F7 HDV requests **gyro 8000 Hz / pid_denom 2 = 4000 Hz PID**
  (`src/sched/loop_rate.c`). dummy and tmotor_f7_v2 keep 1000/1.
- MPU6000 on Kakute: DLPF_CFG 0 (8 kHz output rate), SMPLRT_DIV 0, verified by
  readback. All register writes happen at 1 MHz. After that, SPI4 is re-clocked
  to ≤20 MHz for sensor reads only (PS-MPU-6000A §6.3), which gives 13.5 MHz
  from PCLK2 108 MHz.
- Filter dt and PID dt follow the active rate. Filters use gyro_hz/denom and
  PID uses measured elapsed time (PID-ELAPSED-TIME.md). No fixed 1/1000 or
  1/4000 is left in `tasks.c`.
- A rolling ~1 s loop-rate window, frozen `status` keys, and a runtime fallback
  policy.

Flash is held: this is verified with host and Kakute cross builds only.

## Frozen `status` contract

These three lines come right after `loop:` (`src/drivers/loop_status_cli.h`):

| key | value | meaning |
|---|---|---|
| `loop_target_hz` | uint32 | scheduler gyro_hz / pid_denom that is currently active |
| `loop_actual_hz` | uint32 or `unavailable` | PID cascade runs counted in the last closed window of about 1 s. The window closes at the first gyro slot ≥1 s after it opened. It reads `unavailable` until the first window closes. If a window stays open ≥2 s (stall), the open window is reported, so a stall shows as a drop instead of an old value. |
| `loop_overruns` | uint64 | scheduler overruns since boot. This is the same counter as `timing` `cycle_overruns`. A rate change does not reset it. |

`loop_rate` (read-only) prints the policy: `loop_rate_api: 1`, profile, active,
reason, guard level, gyro ODR, gyro SPI Hz, and `loop_rate_end: 1`.

The Configurator (Setup → Loop rate) shows these values exactly as sent. A
missing key, `unavailable`, a duplicated key or a malformed value shows
"unknown".

## Fallback policy (`loop_rate_select`)

| reason | result | when |
|---|---|---|
| `board-profile` | 8000/2 (Kakute), 1000/1 (others) | default |
| `no-high-res-timebase` | 1000/1 | `hal_time_source` is not DWT (ms fallback) |
| `dshot-bidir-polled-listen` | 1000/1 | bidirectional DShot on (see below) |
| `gyro-odr-below-8k` | 1000/1 | healthy gyro reports ODR < 8 kHz |
| `gyro-spi-clock-slow` | 1000/1 | healthy gyro SPI read clock < 10 MHz |
| `overrun-guard` | 4000/2 then 1000/1 | two closed windows in a row with overruns > 1% of gyro slots, per step |

The guard latches and never raises the rate by itself. A drop applies even
while armed. A raise (for example bidir turned off) applies only while
disarmed. `scheduler_set_rate` keeps the since-boot counters and restarts the
rate averages and the window.

## Timing budget (structural estimate, not measured on hardware)

At 8 kHz gyro the slot is 125 µs. Every other slot also runs the PID cascade,
so the PID period is 250 µs.

| item | estimate |
|---|---|
| Gyro SPI read (17 B at 13.5 MHz, polled) | ≈13 µs (was ≈136 µs at 1 MHz, which exceeds the slot) |
| Gyro task compute (attitude: atan2f×2, sinf, cosf×2, tanf, sqrtf; filters) | ≈10–25 µs |
| PID-slot extras (filter, pid ×3, pid_diag, mixer, DShot DMA arm ×4, blackbox capture) | ≈35–60 µs |
| **PID slot total** | **≈65–100 µs of 125 µs** (IPC 0.3–0.5 from flash) |
| Pessimistic (IPC 0.2: I/D-cache and ART are off on bring-up) | ≈145 µs, which overruns |
| CPU load at 8k/4k | ≈35–55% |

The estimate comes from `arm-none-eabi-nm -S` code sizes of the hot path (for
example pid_update 1336 B, attitude_update 1128 B, gyro_sample 972 B,
pid_diag_update 1068 B, hal_tim_dma_start_burst 752 B). The host cannot prove
that 4 kHz fits. The runtime overrun guard exists for that reason, and the
first hardware session must read `timing` `cascade_exec_max_us` and
`loop_overruns`.

DShot300 TX-only is DMA-driven: a frame takes ≈70 µs, well within the 250 µs
PID period.

## Bidirectional DShot

The polled listen (`hal_tim_ic.c`) blocks the CPU for:

- TX frame ≈70 µs (DShot300) or ≈35 µs (DShot600)
- ESC turnaround ≈30 µs
- GCR reply ≈56 µs (DShot300) or ≈28 µs (DShot600)
- then `IC_QUIET_GAP` 2000 spins, ≈0.5–1.1 ms
- with no reply, up to `IC_SPIN_BUDGET` 50000 spins (many ms)

The protocol minimum alone is ≈156 µs (DShot300) or ≈95 µs (DShot600), plus
the cascade. Neither fits a 125 µs slot. With bidir on, the policy forces
1000/1, where it already overruns today because of the quiet gap. Making bidir
compatible with 4 kHz needs an asynchronous (DMA/IRQ input-capture) receive
path, which is out of scope here.

## Hardware risks (flash held)

- Real `cascade_exec_max_us` with no I-cache or D-cache (the guard will step
  down if it is too slow).
- There is no EXTI data-ready sync (the EXTI HAL is a stub). The 8 kHz MPU
  output and the scheduler beat drift against each other, so expect occasional
  duplicate or skipped samples.
- Signal integrity of SPI4 at 13.5 MHz on the Kakute layout.
- DLPF changes from 42 Hz to 256 Hz, so more gyro noise reaches the software
  LPF (320 Hz default).
- Long CLI commands in the cooperative background can delay a gyro slot. This
  shows up as `skipped_gyro_slots` and lateness.
- The blackbox header `loop_hz` is written at start and goes stale if the
  guard changes the rate during a recording.
