# Real RPM and bidirectional DShot: remaining work

This is a development plan, **not implemented functionality**. No bidirectional
mode is enabled by the adjustable-pulse change. Motor tones alone do not prove
that BobFlight commands spin the intended motor or that ESC telemetry works.

## What the existing code actually supports

`bobflight-firmware/src/drivers/dshot.c` sends unidirectional DShot300/600.
`dshot_encode_packet()` fixes the telemetry request bit to zero. Setting that
bit alone would NOT implement same-wire bidirectional telemetry.

`src/hal/stm32f7/hal_tim_dma.c` uses output PWM with timer update DMA, in groups:

| Motor indexes | Pins | Timer channels | Current TX DMA |
| --- | --- | --- | --- |
| M1/M2 (array 0/1) | PB0/PB1 | TIM3 CH3/CH4 | DMA1 stream 2, channel 5 |
| M3/M4 (array 2/3) | PE9/PE11 | TIM1 CH1/CH2 | DMA2 stream 5, channel 6 |

There is no receive-edge capture, TX-to-RX turnaround state machine, telemetry
decoder or validity/age counter. The configurator now has a browser-local
14-pole default and editable count; the firmware does not consume it yet. The motor UI
therefore shows `RPM — / No telemetry`, including in offline simulation, rather
than inventing RPM from a slider or treating absent telemetry as a stopped motor.

## Compatibility information needed

Get the actual ESC manufacturer/model, firmware family and exact version from
the owner. Do not assume the connected ESC is the owner's separate AM32 hardware
project. A supported DShot rate does not by itself prove bidirectional support.
Verify the configured magnetic pole count against the actual motor model before
using mechanical RPM. The owner-requested 14-pole default is a convenient starting
value, not detection; mechanical RPM requires electrical RPM divided by pole pairs.

Bidirectional DShot refers to two-way data on the motor signal wire, not reverse
motor rotation. A separate ESC telemetry wire is a different implementation
route and must not be conflated with bidirectional DShot.

## Staged implementation, without importing GPL implementations

1. **Specify and independently test the protocol core.** Establish polarity,
   checksum rules for each direction, GCR/transition decoding, timing bounds,
   period-to-eRPM conversion, stopped/no-data sentinels and extended-telemetry
   discrimination from public protocol descriptions. Test against independently
   obtained known-good vectors and captured replies; do not validate a decoder
   solely against its own encoder. Review invalid symbols, corrupt checksums,
   zero periods, overflowing values, missing edges and stale data.
2. **Design the F745 capture HAL.** Verify input capture/DMA resources against
   the STM32F745 reference manual and actual board wiring, including conflicts
   with other peripherals. Add a bounded TX → high-impedance RX → TX state
   machine and failure cleanup. Account for shared timers, DMA completion,
   buffer ownership/cache coherency, idle polarity and line contention.
   Preserve the existing unidirectional path as a default-off fallback.
3. **Validate electrically, then integrate.** Use a logic analyzer/scope on a
   props-off bench to verify waveform polarity, line release, ESC turnaround
   and receive timing before applying nonzero throttle. Confirm genuine replies
   and error rates on the owner's exact ESC/firmware. Only then expose per-motor
   electrical RPM, mechanical RPM (with confirmed pole count), sample age and
   error/timeout counters over the CLI and in the configurator.

Missing, invalid or stale telemetry must read unavailable/stale, not 0 RPM.
Even a valid low/zero RPM sample is not a replacement for a physical props-off
procedure and accessible battery disconnect. No flight qualification is implied
by host tests, successful compilation or telemetry on one bench motor.

## Documentation references (concepts only, no copied implementation)

- [PX4 DShot ESC guide](https://docs.px4.io/main/en/peripherals/dshot): distinction
  between output protocol, separate-wire telemetry and bidirectional support;
  ESC/board support must be checked.
- [Bitcraze bidirectional DShot discussion](https://www.bitcraze.io/2026/06/bidirectional-dshot-and-erpm-telemetry-for-the-crazyflie-2-1-brushless/):
  implementation and timing considerations; not used as a source of code.

Reference implementations are not imported or translated. This document makes
no blanket claim about patent or license status of outside material. BobFlight
code added for this feature remains independently authored Apache-2.0 code.
