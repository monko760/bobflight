# DShot frame-start correction

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

## Finding

The c2ed54d timer/DMA startup sequence loads the first nonzero DShot compare
values into active CCR registers with a software update (UG), while CNT=0 and
the timer counter is disabled. PWM1 outputs are already enabled. CEN stops the
counter; it is not an output gate. This can assert the first high pulse during
CPU/DMA setup, extending its high time beyond the intended timer-controlled
width. An interrupt in that interval can extend it further. This affects stop
packets too: DShot value zero still contains sixteen nonzero-width data pulses.

This is a concrete driver startup defect and a plausible explanation for the
reported twitching. It is **not yet a confirmed physical root cause**. No scope,
logic-analyzer capture, ESC decoder feedback, or corrected hardware spin result
has been obtained.

## Narrow correction

- Load active CCR1..4 with zero using UG while the counter is disabled.
- Put frame row 0 (the first bit, zero-based indexing) into the preload registers.
- Start DMA at row 1 for 19 rows x four channels = 76 halfwords.
- Start the timer. The first timed update latches row 0 and requests DMA row 1.
  Later updates latch rows 1..19, including all four trailing all-low rows.

The frame therefore starts with one extra all-low bit period. The first high
edge now originates from a timed update, not CPU setup. The change preserves
pin mapping, DShot300/600 encoding and default, scheduler, MCU clock, 35% cap,
one-second bench deadline, stop controls, and disabled flight arming. It does
not change the sensor path or claim to fix slow telemetry/calibration.

## Regression coverage

`tests/host_dshot_timer.c` includes the real HAL implementation, substituting a
small register/preload/DMA model for MMIO. This is a logic model, not a simulator
of every STM32 detail, DMA arbitration, interrupt latency, or physical wiring.
Its observed properties are: outputs stay low throughout software preparation;
all 16 data bits and four trailing idle rows emerge in order; DMA source/count
matches the preload sequence; repeated frames and stop remain low when idle.

The same test fails on the original startup (`!early_high`) and passes after
the correction. Four bit patterns are rotated across all four motor channels
at both 168/216 MHz and DShot300/600. Group index 0 = TIM3 (APB1), group index 1
= TIM1 (APB2). At 168 MHz / DShot300, the timer periods are respectively 280 and
560 ticks, both 3.333333 microseconds; zero/one high times are 1.25/2.5 us.

Run the full native suite with CMake/CTest. Thirteen tests passed after this
change, including CLI and bench safety. A clean Kakute F745 cross-build passed
with `BOBFLIGHT_FLIGHT_ENABLE=OFF`; disassembly confirms `arming_try_arm`
returns false. These checks do not replace props-off hardware validation.

## Hardware follow-up

Merge through the owner's normal PR workflow, rebuild the matching main-based
bench HEX, and test an individual motor at a low prepared level with all props
removed. Do not raise the 35% limit or repeatedly pulse a stalled motor. If
available, capture the first DShot high pulse and subsequent bit periods with a
logic analyzer or oscilloscope. Verify both timer groups before any sequence.
