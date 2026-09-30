# Loop rate: selectable 1 / 4 / 8 kHz (`loop_rate_hz`), status keys, fallbacks

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Scope

PR #43 shipped PID R0–R2 only. Its "R3 4 kHz" item was left for a follow-up and
no 4 kHz commit exists on any branch. This change is that follow-up, made
user-selectable:

- Persisted CLI setting **`loop_rate_hz`**, exactly `1000`, `4000` or `8000`
  (`src/sched/loop_rate_setting.c`), stored in config **schema 7**.
- Mapping (`src/sched/loop_rate.c`):

  | `loop_rate_hz` | gyro task / pid_denom | MPU6000 |
  |---|---|---|
  | 1000 | 1000 Hz / 1 | DLPF_CFG 3 (1 kHz ODR, 42 Hz DLPF), SPI at the ≤1 MHz register clock. This is the pre-R3 path, unchanged. |
  | 4000 | 8000 Hz / 2 | DLPF_CFG 0 (8 kHz ODR, 256 Hz DLPF), sensor reads re-clocked to ≤20 MHz (13.5 MHz) |
  | 8000 | 8000 Hz / 1 | same as 4000 |

  1000 uses 1000/1 rather than 8000/8: it keeps the proven hardware path, with
  one SPI read per PID loop and the 42 Hz DLPF instead of 8 reads per loop at
  256 Hz.
- Defaults: **4000 on kakute_f7_hdv** (budget below), **1000 on every other
  board**. dummy and tmotor_f7_v2 have no 8 kHz gyro path and refuse 4000/8000.
- MPU6000 on Kakute: every register write happens at 1 MHz and is verified by
  readback. At boot, after `persist_load`, `gyro_select_output_rate()` writes
  CONFIG for the saved setting. A failed write drops `config_ok`, and the
  policy then reports `gyro-odr-below-8k` and runs 1000/1.
- Filter dt and PID dt follow the active rate. Filters use gyro_hz/denom and
  PID uses measured elapsed time (PID-ELAPSED-TIME.md).
- A rolling ~1 s loop-rate window, frozen `status` keys, and a runtime fallback
  policy.

Flash is held: this is verified with host and Kakute cross builds only.

## CLI setting `loop_rate_hz`

It follows the existing `set`/`get`/`diff`/`dump`/`defaults`/`save`
conventions.

```
get loop_rate_hz            -> loop_rate_hz=4000
set loop_rate_hz 8000       -> ok loop_rate_hz=8000
                               note: loop_rate_hz takes effect after save + reboot
set loop_rate_hz 2000       -> set failed: loop_rate_hz must be 1000, 4000 or 8000
set loop_rate_hz 4000       -> set failed: loop_rate_hz 4000 not supported on tmotor_f7_v2 (no 8 kHz gyro path)
set loop_rate_hz 8000       -> set failed: armed            (while armed, like every set)
```

- Only the exact tokens `1000`, `4000` and `8000` are accepted. `4000.0`,
  `04000`, `+4000` and `4e3` are rejected.
- The value is applied **at boot only**. `set` changes RAM, `save` stores it,
  and the new rate runs after a reboot. Until then, `loop_rate` reports
  `loop_rate_pending_reboot: 1`. That flag lets the Configurator tell "not
  rebooted yet" apart from "the firmware applied a fallback".
- `diff` prints `set loop_rate_hz N` only when N differs from the board
  default. `dump` always prints it. `defaults` resets it to the board default.
  `storage` and export `scope` end in `,loop_rate_hz`.

## Persistence: schema 7

- Payload 192 bytes, which is the config_store `MAX_PAYLOAD`. The schema 6
  bytes 0..187 are unchanged, and `loop_rate_hz` is stored as u32 LE at bytes
  188..191.
- On load, the value must be 1000/4000/8000 and supported by the board.
  Otherwise the load fails with `invalid_settings`, exactly like any other bad
  field.
- A schema ≤6 record migrates by adding the board default (4000 on Kakute,
  1000 elsewhere). It stays `dirty` until the next Save. The old slot is kept,
  and older firmware keeps reading its schema 6 record.
- Tests: `config_store` (schema6→7 migration, all write cuts, downgrade
  protection), `persist_config` (migration default, round-trip of 1000/8000,
  rejection of 2000/0), and `loop_rate_setting_cli` (real host CLI per board,
  including save plus a host warm reboot).

## Frozen `status` contract

These three lines come right after `loop:` (`src/drivers/loop_status_cli.h`):

| key | value | meaning |
|---|---|---|
| `loop_target_hz` | uint32 | scheduler gyro_hz / pid_denom that is currently active |
| `loop_actual_hz` | uint32 or `unavailable` | PID cascade runs counted in the last closed window of about 1 s. The window closes at the first gyro slot ≥1 s after it opened. It reads `unavailable` until the first window closes. If a window stays open ≥2 s (stall), the open window is reported, so a stall shows as a drop instead of an old value. |
| `loop_overruns` | uint64 | scheduler overruns since boot. This is the same counter as `timing` `cycle_overruns`. A rate change does not reset it. |

`loop_target_hz` is always the rate **actually applied**, including any
fallback. It is never the requested setting.

`loop_rate` (read-only) prints the policy: `loop_rate_api: 1`,
`loop_rate_setting_hz` (RAM), `loop_rate_boot_setting_hz` (applied at boot),
`loop_rate_pending_reboot` 0|1, `loop_rate_profile` (gyro/denom requested by
the boot setting), `loop_rate_active`, `loop_rate_reason`, guard level, gyro
ODR, gyro SPI Hz, and `loop_rate_end: 1`.

The Configurator's Setup → Loop rate section does two things:
- It shows the status values exactly as sent. A missing key, `unavailable`, a
  duplicated key or a malformed value shows "unknown".
- It has a 1 kHz / 4 kHz / 8 kHz selector. The selector reads and writes
  `loop_rate_hz` and saves through the existing verified save flow. It always
  states that a change needs Save + reboot, shows a pending change, and shows
  "unknown" (disabled) on an older FC. When the applied target differs from
  the boot setting, it names the firmware's reason.

## Fallback policy (`loop_rate_select`)

The requested rate comes from the boot setting. A fallback never changes the
setting and never runs slower silently. `loop_target_hz` and
`loop_rate_reason` always report it.

| reason | result | when |
|---|---|---|
| `setting` | the setting's mapping | default, nothing blocks it |
| `board-has-no-8k-gyro-path` | 1000/1 | defensive: 4000/8000 on a board without the 8 kHz path (normally refused at `set` and at load) |
| `no-high-res-timebase` | 1000/1 | `hal_time_source` is not DWT (ms fallback) |
| `dshot-bidir-polled-listen` | 1000/1 | bidirectional DShot on (see below) |
| `gyro-odr-below-8k` | 1000/1 | healthy gyro reports ODR < 8 kHz, or its output-rate configuration failed |
| `gyro-spi-clock-slow` | 1000/1 | healthy gyro SPI read clock < 10 MHz |
| `overrun-guard` | next step of the ladder | two closed windows in a row with overruns > 1% of gyro slots, per step |

Guard ladders (the requested rate is judged only while `setting` or
`overrun-guard` is in effect):

- `loop_rate_hz 8000`: 8000/1 (8 kHz) → 8000/2 (4 kHz) → 4000/2 (2 kHz) → 1000/1
- `loop_rate_hz 4000`: 8000/2 (4 kHz) → 4000/2 (2 kHz) → 1000/1
- `loop_rate_hz 1000`: not guarded (the pre-R3 behaviour)

The guard latches and never raises the rate by itself. A drop applies even
while armed. A raise (for example bidir turned off) applies only while
disarmed. `scheduler_set_rate` keeps the since-boot counters and restarts the
rate averages and the window. A runtime fallback to 1000/1 from an 8 kHz
setting keeps DLPF_CFG 0 until the next boot (the sensor is not re-configured
while flying).

## Timing budget (structural estimate, not measured on hardware)

At 8 kHz gyro the slot is 125 µs. At `loop_rate_hz 4000`, every other slot also
runs the PID cascade (PID period 250 µs). At `8000`, every slot runs it (PID
period 125 µs).

| item | estimate |
|---|---|
| Gyro SPI read (17 B at 13.5 MHz, polled) | ≈13 µs (was ≈136 µs at 1 MHz, which exceeds the slot) |
| Gyro task compute (attitude: atan2f×2, sinf, cosf×2, tanf, sqrtf; filters) | ≈10–25 µs |
| PID-slot extras (filter, pid ×3, pid_diag, mixer, DShot DMA arm ×4, blackbox capture) | ≈35–60 µs |
| **PID slot total** | **≈65–100 µs of 125 µs** (IPC 0.3–0.5 from flash) |
| Pessimistic (IPC 0.2: I/D-cache and ART are off on bring-up) | ≈145 µs, which overruns |
| CPU load at 4000 (8000/2) | ≈35–55%: a PID slot may borrow from the following gyro-only slot |
| CPU load at 8000 (8000/1) | ≈52–80%; pessimistic >100% |

The estimate comes from `arm-none-eabi-nm -S` code sizes of the hot path (for
example pid_update 1336 B, attitude_update 1128 B, gyro_sample 972 B,
pid_diag_update 1068 B, hal_tim_dma_start_burst 752 B). The host cannot prove
the rate fits. The runtime overrun guard exists for that reason, and the
first hardware session must read `timing` `cascade_exec_max_us` and
`loop_overruns`.

**Default 4000 on Kakute.** In the nominal case the PID slot fits inside one
125 µs slot. In the pessimistic case it spills into the gyro-only slot and
still averages under 250 µs. The guard steps down (4000/2, then 1000/1) if
real hardware disagrees.

**8000 on Kakute is accepted but experimental.** The nominal 65–100 µs of
125 µs leaves thin headroom (20–48%), and the pessimistic case does not fit.
It is not refused, because the budget cannot be proven either way on the host
and the guard reports an honest fallback (8000/1 → 8000/2 → …, reason
`overrun-guard`, `loop_target_hz` = the applied rate) instead of running
slower silently.
- DShot300 TX is DMA-driven: a frame takes ≈53 µs (16 bits × 3.33 µs), or
  ≈70 µs with the inter-frame gap, which fits inside 125 µs. The CPU only arms
  4 DMA bursts.
- The gyro SPI read (≈13 µs at 13.5 MHz) fits.
- Bidirectional DShot cannot fit at 8 kHz (or 4 kHz): with bidir on, the
  policy forces 1000/1 (see below).

## Bidirectional DShot

The polled listen (`hal_tim_ic.c`) blocks the CPU for:

- TX frame ≈70 µs (DShot300) or ≈35 µs (DShot600)
- ESC turnaround ≈30 µs
- GCR reply ≈56 µs (DShot300) or ≈28 µs (DShot600)
- then `IC_QUIET_GAP` 2000 spins, ≈0.5–1.1 ms
- with no reply, up to `IC_SPIN_BUDGET` 50000 spins (many ms)

The protocol minimum alone is ≈156 µs (DShot300) or ≈95 µs (DShot600), plus
the cascade. Neither fits a 125 µs slot. With bidir on, the policy forces
1000/1 for both `4000` and `8000` settings (reason `dshot-bidir-polled-listen`),
where it already overruns today because of the quiet gap. Making bidir
compatible with 4/8 kHz needs an asynchronous (DMA/IRQ input-capture) receive
path, which is out of scope here.

## Hardware risks (flash held)

- Real `cascade_exec_max_us` with no I-cache or D-cache (the guard will step
  down if it is too slow). The 8000 setting has thin headroom even nominally.
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
- The guard thresholds (>1% overruns in 2 consecutive ~1 s windows) are
  untuned on hardware.
