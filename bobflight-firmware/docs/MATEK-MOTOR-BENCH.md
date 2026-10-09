# Matek F722-PX: Actual rates and disarmed DShot bench candidate

This is development firmware, not flight-qualified. The Matek build still does not define `BOBFLIGHT_FLIGHT_ENABLE`; arming, failsafe, freshness and bench limits are unchanged. Normal DShot is implemented. Bidirectional capture/RPM is not implemented for this target and its enable command is refused on the MCU.

## Fresh install, not migration

Only schema13 configuration is supported. Legacy cubic rates, the global `rate_expo`, rate model selector, schema1..12 loaders and migration tests are removed. Old/future/foreign records are not interpreted or automatically erased. Erase internal configuration as part of a deliberate fresh installation. Re-enter receiver/map/modes/mounting and calibrate again. Do not paste an old dump wholesale. `diff all`, explicit `save` and verified reload remain supported.

Actual-only controls: independent center, max (deg/s) and expo (0..1 in CLI, percent in UI) per axis. BobFlight defaults are 200/800/0.30. Existing 2% stick deadband is applied once. Center above max follows Actual semantics: effective endpoint equals center.

## TX routing and nominal timing

Derived from the board IR and ST timer/DMA register maps, not a physical waveform measurement.

| Motor | Pin / AF | Timer channel | Update DMA |
|---|---|---|---|
| M1 | PC8 / AF3 | TIM8 CH3 | DMA2 stream1 channel7 |
| M2 | PC9 / AF3 | TIM8 CH4 | DMA2 stream1 channel7 |
| M3 | PB4 / AF2 | TIM3 CH1 | DMA1 stream2 channel5 |
| M4 | PB5 / AF2 | TIM3 CH2 | DMA1 stream2 channel5 |

At the configured 216 MHz CPU clock, TIM8 nominally clocks at 216 MHz and TIM3 at 108 MHz. DShot300 gives period counts720/360 and zero/one high counts270/540 and135/270. DShot600 gives counts360/180 and high counts135/270 and67/135 (integer quantization under one timer tick). ARR is period minus one and PSC is zero.

The development control loop remains1 kHz, separate from DShot bit timing. Each burst uses a leading idle slot,16 data bits and4 zero slots. First data bit is latched by a timed update, never CPU setup. DMA completion occurs after data bits; ongoing idle stays low. DMA reads SRAM-backed,32-byte-aligned buffers with cache clean before enable. Stream shutdown is bounded. Busy/error paths cancel pending frames and drive zero compares. Existing Kakute bidirectional coupling is not applied to Matek timer groups.

## Software verification

- Matek ARM firmware and browser configurator production builds pass.
- Actual math, per-axis UI, nine-key saves, old-version rejection and persistent schema13 tests pass.
- Real HAL register/preload model covers Matek and Kakute at168/216 MHz, DShot300/600, all16 bits, idle slots, no stretched startup pulse, repeated bursts, route/AF/MOE checks, busy-DMA cancellation and stop.
- This branch deliberately retains Blackbox schema3. The larger schema4 logging, RSSI, barometer and NOR-probe changes stay in draft PR92 until their separate regressions are resolved. No Blackbox throughput test is removed or relaxed here.
- This merge does not add NOR logging or BMP280 acquisition. Onboard recording remains a separate milestone.

## Bench installation/testing gates

1. Remove all propellers. Confirm a DShot-capable ESC, correct signal wiring, common ground and a suitable/current-limited power source. Do not power motors from USB. First configure with motor power disconnected.
2. Verify ROM DFU recovery and software `bl` entry on this particular board before erasing. The bootloader command must refuse unsafe states. If unsaved settings block entry, consciously use the existing discard workflow; never bypass safety checks. Physical BOOT entry/recovery remains a hardware check, not established by compilation.
3. Perform a deliberate full internal-flash erase using the established STM32 DFU flashing procedure, then flash this exact Matek image. Ordinary application-only flashing can leave incompatible configuration behind. Do not alter option bytes or external flash as a shortcut.
4. Expect version suffix `store13-cal2-mount1-actual1-dshot1`, target `matek_f722_px`, `dshot_bound:4/4`, disarmed state and schema13. If storage reports `fresh_install_required`, stop; do not repeatedly save or restore old dumps.
5. Re-enter only reviewed settings for this bench board. The previously reported board mounting was roll180/pitch0/yaw180; reconfirm physical orientation before using it. Calibrate stationary, explicitly `save`, then power-cycle and verify settings/calibration persist. Set `dshot300` using the actual CLI spelling `dshot 300`; keep bidirectional DShot off. Confirm the1 kHz loop, receiver freshness, low throttle and healthy sensor/output status.
6. With props still removed, secure the motor and connect ESC power. Use only the existing disarmed, time-limited single-motor bench control, starting at its lowest supported setting. Do not arm. Verify M1 through M4 identity individually, never assuming the wiring matches labels. Stop on wrong output, reset, stale receiver, USB loss, unhealthy DShot, unexpected continued rotation or abnormal current/heat.
7. Where available, verify waveforms with a logic analyzer: DShot300 bit period about3.333us,16 data bits, idle gap, valid CRC, no startup-stretched bit. These hardware measurements and actual motor spin have NOT been performed remotely.

If software bootloader entry fails, disconnect motor power and use the physically verified BOOT/ROM DFU recovery method. Do not remove checks or keep raising throttle to compensate for a timing/wiring problem.
