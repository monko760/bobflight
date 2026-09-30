# DShot bidirectional eRPM at a 4 kHz loop (B2)

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

Status: host-tested, **flash held**. Kakute F7 HDV M1–M4. Stacked on #57
(loop-rate selector). CLI keys unchanged: `dshot_bidir`, `erpm_m1..m4`,
`dshot_telem_m1..m4` (`ok|crc_fail|invalid|timeout|stale|none`). No config
schema change: bidir stays RAM-only, default off.

## Why this design

Before B2 the reply was received by polling CCxIF after each TX
(`dshot-bidir-polled-listen`). That blocked the CPU for the frame, the ESC
turnaround, the reply and a 0.5–1.1 ms quiet gap, so the loop-rate policy
forced 1000/1 whenever bidir was on.

B2 receives the reply with **DMA input capture, pipelined one frame behind,
never waited for**:

1. `dshot_write()` (main loop, PID slot) first calls `dshot_telem_poll_all()`:
   it harvests the capture of the *previous* frame (bounded: disable ≤ 4 DMA
   streams with a ≤ 64-spin EN check, read CNT/SR, copy ≤ 64 timestamps),
   decodes GCR and updates eRPM/status.
2. It encodes the new packets, arms the four capture buffers
   (`dshot_telem_arm_listen_all()`) and fires the TX bursts.
3. The TX DMA transfer-complete IRQ (DMA1_Stream2 = IRQ 13, DMA2_Stream5 =
   IRQ 68, NVIC priority 1: above UART 2 and USB 5, below SysTick 0) switches
   each timer group to capture: UDE off, ARPE off, ARR = 0xFFFF (free-running
   16-bit timebase), CCMR = input capture on TIx with filter N = 8, CCER =
   both edges, capture DMA peripheral-to-memory 16-bit. It records CNT and
   clears UIF. That ISR is a few dozen register writes, with no loops.
4. The ESC's reply lands in the buffers with no CPU involvement until step 1
   of the next cycle.

Alternatives rejected:

- *Blocking capture with a shorter window*: still ≈95–156 µs of CPU per PID
  slot, which does not fit a 250 µs PID period next to the cascade.
- *Edge IRQ per transition*: up to about 21 IRQs per motor per frame (84 per
  cycle), each competing with UART/USB. DMA takes the same edges with no CPU.
- *Separate capture timer or pin remap*: needs different AF pins, and the IR
  pin lock (`ir_verified=false`) says no remap.

The TCIE bit on the TX stream is set only while a capture is armed, so with
bidir off the TX path is identical to #57.

## Protocol fixes included (public BDShot behaviour)

- A bidir frame carries the telemetry bit **0** and an **inverted CRC**
  (`dshot_encode_packet_bidir`). The old code set the telemetry-request bit
  and kept the normal CRC, so the ESC would not have detected a bidir frame.
- The line is **inverted** when bidir is on: CCxP on the four motor channels
  and a pull-up on the pins (`hal_tim_dma_set_inverted`, called from
  `dshot_bidir_set_enabled`). The ESC replies inverted, and the idle line is
  high.
- Many ESCs pick the protocol at power-up: after `set dshot_bidir on` at
  runtime the ESC may need a power cycle before it answers.

## Timeline (worst case, from `src/drivers/dshot_bidir_budget.h`)

All times are from TX start. The TX has one leading low bit, 16 data bits and
the idle slots up to DMA TC at bit 19. The reply is 21 GCR bits at 5/4 of the
DShot bit rate, with a 30 µs nominal and 40 µs budgeted turnaround.

| | DShot300 | DShot600 |
|---|---|---|
| DShot bit | 3.333 µs | 1.667 µs |
| Frame data end (17 bits) | 56.7 µs | 28.3 µs |
| TX TC (19 bits) + 2 µs ISR → capture live | 65.3 µs | 33.7 µs |
| Reply bit / 21-bit reply | 2.667 µs / 56 µs | 1.333 µs / 28 µs |
| Reply end, 30 µs turnaround (nominal) | 142.6 µs | 86.3 µs |
| Reply end, 40 µs turnaround (budget) | 152.6 µs | 96.3 µs |
| Needed period (+30 µs loop jitter) | 182.6 µs | 126.3 µs |
| **4 kHz (250 µs)** | **fits: 67 µs worst, 107 µs nominal** | **fits: 124 µs** |
| **8 kHz (125 µs)** | **no: −57.6 µs** | **no: −1.3 µs** |

The capture window is open from about 34/65 µs after TX start until the next
harvest, so a late turnaround only moves the reply inside the window. The
real limit is that the reply must finish before the next frame's harvest.

**8 kHz verdict: not proven.** DShot600 misses by 1.3 µs even before real
ISR latency is known. With bidir on, `loop_rate_hz 8000` is therefore capped
to 8000/2 (4 kHz), reason `dshot-bidir-reply-window`. `4000` runs as set.
`loop_rate_ladder_bidir()` applies this cap, and the overrun guard ladder for
8000 + bidir becomes 8000/2 → 4000/2 → 1000/1.

## Fallback: `dshot-bidir-capture-failed` → 1000/1

`dshot_telem` counts consecutive cycles where at least one motor had a
*capture fault*:

- `TX_NOT_DONE`: the window never opened before the harvest.
- `DMA_ERROR`: TE/DME, or the stream would not stop.
- a *truncated* reply, i.e. edges still arriving at harvest.

ESC silence and CRC/GCR errors do **not** count (they are ESC or wire
problems, not a timing problem). After 32 consecutive cycles
(`DSHOT_TELEM_CAPTURE_FAIL_LIMIT`) the failure latches and the policy selects
1000/1 with reason `dshot-bidir-capture-failed`, for every setting including
1000, so the cause is visible. It drops immediately, even while armed. A raise
back needs the latch cleared (bidir toggled, or reboot) and happens only while
disarmed. The per-motor status still shows the truth (`timeout` for
truncated/no window) and eRPM reads `none`.

## Decoder hardening (`dshot_telem.c`)

- Raw timestamps, 16-bit modular deltas; runs rounded to reply bits.
- A run shorter than half a bit is INVALID (glitch), never a made-up eRPM.
- Idle runs longer than 4 bits before the reply are skipped (pre-frame
  glitches).
- The final low run has no closing edge if the line stays low; it is padded
  only if ≤ 3 bits are missing **and** the line has been quiet for ≥ 4 bits
  (`hal_dshot_ic_tail_ticks`). Otherwise the reply counts as truncated →
  TIMEOUT. This stops a cut-off reply from passing GCR/CRC by chance.
- The tail is wrap-safe (`src/hal/dshot_ic_tail.h`): TIM1 at 216 MHz wraps
  every ≈302 µs, which is less than a 1 kHz period. CNT at window open plus the
  timer's UIF give a quiet-time lower bound that never aliases a long quiet
  time into a short one. A host test covers this: the 1 kHz pipeline failed
  without it. This assumes every captured edge arrives within the first
  counter period after the window opens (≥ 302 µs on TIM1, ≥ 604 µs on TIM3).
  Any in-spec reply ends by ≈153 µs after TX start.

## DMA map (Kakute F7 HDV, STM32F745)

Source: RM0385 (STM32F75xxx/74xxx) §8.3.3, "DMA1 request mapping" and "DMA2
request mapping" tables (Tables 27 and 28). RM0410/RM0431 list the same rows.

| Motor | Pin | Channel | TX (unchanged) | Capture (new) |
|---|---|---|---|---|
| M1 | PB0 AF2 | TIM3_CH3 | TIM3_UP DMA1 S2/C5 | DMA1 **S7/C5** |
| M2 | PB1 AF2 | TIM3_CH4 | TIM3_UP DMA1 S2/C5 | DMA1 **S2/C5** (request "TIM3_CH4/TIM3_UP": same stream as TX, reused only after TC with UDE cleared) |
| M3 | PE9 AF1 | TIM1_CH1 | TIM1_UP DMA2 S5/C6 | DMA2 **S1/C6** |
| M4 | PE11 AF1 | TIM1_CH2 | TIM1_UP DMA2 S5/C6 | DMA2 **S2/C6** |

Why these streams:

- **M3 on S1 instead of S3/C6.** S3 is SPI1_TX's only remaining stream
  (the other, S5, is TIM1_UP), so keeping S3 free leaves the SD card a DMA
  option.
- **M4 on S2/C6.** This is the only TIM1_CH2-only request. S6/C0 is the ORed
  TIM1_CH1/CH2/CH3 request and cannot run next to a separate CH1 capture.
- **M1 and M2.** The only TIM3_CH3 and TIM3_CH4 requests.

Streams these choices take away (no live conflict: today SPI4 gyro, SPI1 SD,
USART6 CRSF and ADC are polled/IRQ-driven and use no DMA):

| Stream taken | Also used by | Effect |
|---|---|---|
| DMA1 S7 | UART5_TX (C4), I2C2_TX (C7), other rows | none of these used with DMA on Kakute |
| DMA1 S2 | already TX | — |
| DMA2 S1 | USART6_RX (C5), SPI4_TX (C4, primary) | CRSF RX DMA would need S2/C5, which is also taken → **no USART6_RX DMA**. SPI4_TX keeps S4/C5 |
| DMA2 S2 | USART6_RX alt (C5), USART1_RX (C4), SPI1_RX alt (C3) | USART1_RX keeps nothing (S5 is TIM1_UP). SPI1_RX keeps S0/C3 |

Any future DMA user (CRSF RX DMA, SD DMA, gyro DMA) must re-check this table.

## Tests (host, `ctest`)

- `dshot_erpm_4k` (new, `tests/host_dshot_erpm_4k.c`): a timeline-simulated
  HAL plus ESC model with a hardware-faithful counter (CNT = 0 at TX fire,
  PWM wrap until TC, then free-running 16-bit).
  - GCR from capture buffers: valid, ±18 % jitter, sub-bit glitch → INVALID,
    CRC, truncated → TIMEOUT, silent, in-reply 16-bit wrap, unterminated final
    run, pre-frame glitch.
  - Pipeline at 4 kHz and 1 kHz (and 2 kHz), DShot300/600, ±jitter, the
    budget-worst turnaround, motors independent, stale.
  - No-block: 20000 silent cycles, one harvest per cycle, and a bound on the
    worst `dshot_write`.
  - Capture-failure latch after 32 cycles; silence and CRC do not trip it.
  - Loop-rate interplay: 4000 kept, 8000 capped to 8000/2, failure → 1000/1.
  - Wrap-safe tail.
- `loop_rate_policy_status` (`host_loop_rate.c`): bidir sections (4000 kept,
  capture failure drops while armed and raises only disarmed, 8000 capped at
  300 and 600, guard ladder, pure ladder checks).
- `dshot_timer`: TX TC at slot 18 with the line idle, TCIE only when a
  capture is armed, CCxP polarity on and off.
- `dshot_telem_r0c`: bidir encode (inverted CRC, telem bit 0), inversion,
  timestamp inject across a wrap.

## Hardware-only risks (not provable on host)

- Protocol: the inverted line and inverted CRC are public BDShot behaviour
  but untested on these ESCs. ESC re-detection after a runtime `set
  dshot_bidir on` may need a power cycle.
- Real turnaround: the budget is 40 µs. An ESC answering later cuts margin at
  DShot300 4 kHz (67 µs worst).
- ISR latency: the TC ISR has priority 1. If something masks IRQs for long,
  the window opens late. At DShot600 the reply starts about 29 µs after TC, so
  up to that is tolerated.
- DMA1 S2 reuse for M2 (TIM3_CH4/TIM3_UP request): UDE must be off before the
  stream is re-programmed. The code does this first in the ISR, but it is
  unobserved on silicon.
- D-cache: the buffers are in SRAM1/2 (`.dma`). They are invalidated after
  capture if D-cache is enabled (it is off on bring-up).
- Tail/UIF assumption: an edge more than one counter period after the window
  opens would be misread. It is out of spec, and such a reply fails GCR/CRC in
  practice.
- The guard level is re-indexed on the 8000 ladder when bidir toggles.

## First-flash checks (props off; scope)

1. PB0/PB1/PE9/PE11 with bidir on: an inverted frame (idle high), the ESC reply
   after the turnaround. Measure the turnaround and the reply length.
2. TC → capture switch timing: time from the last TX bit to the channel
   switching to input (optionally a debug GPIO toggle in the TC ISR, not in
   this PR).
3. At `loop_rate_hz 4000`: reply end vs the next TX start (the margin).
4. CLI: `loop_rate` (reason `setting` at 4000, `dshot-bidir-reply-window` at
   8000), `status` loop_target_hz, `get dshot_telem_mN` = `ok`,
   `get erpm_mN` numeric and plausible at idle, `timing` overruns.
