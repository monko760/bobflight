# Blackbox compatibility and Matek I2C candidate

## Objective and current boundary

Produce truthful, high-rate BobFlight logs readable in unmodified Betaflight Blackbox Explorer. This branch adds original I2C/BMP280 drivers and schema 4 capture/encoding. It does **not** complete Matek external NOR recording, alter arming/flight enablement, change persistent configuration schema13, or establish hardware or flight readiness.

The expanded payload regression is repaired with standard previous-value P frames and an absolute I frame at least every32 records. Every decoded field is preserved. The requested recording rates,64 KiB ring allocation,32 KiB normal-load ring-peak bound and existing latency/drop assertions are unchanged. Two artificial congestion inputs were recalibrated (15 to20 ms,8 to7.7 ms write-busy time) so the smaller records still exercise the same loss/halving assertions; these are model stimuli, not measured SD-card specifications.

## Implemented software

- STM32F722 I2C1: PB8 SCL / PB9 SDA, AF4 open drain, PCLK1 range validation, conservative standard-mode timing. Repeated-start register reads and register writes yield between bytes. BUSY refusal, NACK/error checks and a 20 ms timeout are bounded. No DMA/interrupt or global clock changes. There is no aggressive stuck-slave clock-pulse recovery; a physically held-low bus can require hardware recovery.
- BMP280: probes 0x76 then 0x77, requires ID 0x58, checks NVM readiness, reads all 24 trim bytes, and uses forced x1 temperature/x4 pressure conversions (`0x2D`). Background-only single-precision compensation; target 20 Hz, 250 ms freshness, one-second failure retry. No barometer values feed control or failsafe decisions.
- Relative altitude: centimeters above the mean of the first 32 valid startup pressure samples. Reference and altitude-valid flags prevent treating warmup as measured zero altitude. Sensor restart establishes a new reference; sequence/reference fields make this observable. It is neither GPS/MSL altitude nor altitude hold.
- CRSF 0x14: real per-antenna RSSI dBm, selected antenna, SNR, RF mode and LQ. Signal freshness comes from link-stat packets, not RC packets. Existing control/link-gate acceptance is preserved even if new antenna metadata is invalid. LQ-only compatibility calls cannot manufacture valid RSSI.
- Logged throttle setpoint is the actual post-failsafe mixer input; pilot `rcCommand[3]` remains independent.
- Read-only `flash_info`: SPI2 JEDEC/status only. No WREN/program/erase/reset commands, no recorder-capable claim. Recognized IDs EF4018/EF4019 report 16/32 MiB; other IDs remain unknown.

## Wire contract

Schema 4 is self-describing: 71 fields without the barometer backend, 79 with it. Custom names use `bf...`, replacing schema 3's `bobflight...`. Older files retain their original names. A header-line length guard protects stock Explorer's parser.

| Requested area | Implemented / remaining work | Concrete acceptance criterion |
|---|---|---|
| PID | Existing P/I/D and validity; no invented feedforward term | Real controller trace equals decoded terms |
| RC commands | Existing normalized stick-to-command representation | Pilot throttle remains distinct from failsafe mixer throttle |
| Setpoint | Actual angular demand and corrected mixer throttle | Capture + decoder regressions preserve both sources |
| Battery | Matek ADC path still missing | Calibrated voltage/current acquisition and unit checks before logging |
| Magnetometer | No supported source attached/implemented | Omit until an actual driver/source is available |
| Altitude | BMP280 startup-relative `baroAlt`, cm | 32-sample reference, correct sign/units, stale/failure flags; hardware check pending |
| RSSI | Standard normalized `rssi` plus raw dBm, LQ, SNR, antenna, RF mode, age/validity | Normalize selected dBm from -130..0 to 0..1023; never substitute LQ |
| Gyro | Existing `gyroADC[]`, 0.1 degrees/s | Stock conversion agrees with source values |
| Attitude | Actual estimator Euler values converted to Q15 `imuQuaternion[]` in background encoding | Stock Explorer reproduces roll/pitch/gyro-relative yaw; not magnetic heading |
| Accelerometer | `accSmooth[]`, 4096 counts/g, `H acc_1G:4096` | Decoded acceleration equals body-frame source; validity does not claim calibration |
| Debug | Existing custom diagnostics; standard debug-mode selection remains open | Explicit mode/channel meanings and units, not placeholder arrays |
| Motor | Existing requested DShot commands | Do not call them measured ESC output or functional Matek motor support |
| GPS | No implemented/attached source | Omit, not fabricated fix/coordinates |
| RPM | Existing eRPM/100 and telemetry mask | Valid ESC telemetry and configured pole count; bare-board zero is not measured RPM |
| Unfiltered gyro | Standard `gyroUnfilt[]` replaces the custom raw-gyro name | Stock gyro units and pre-filter capture tap verified |
| Servo | No implemented output source | Omit, not synthetic servo commands |

Barometer fields: `baroAlt`, `bfBaroTempCentiC`, `bfPressurePa`, `bfBaroReferencePa`, `bfBaroAgeMs`, `bfBaroValid`, `bfBaroAltValid`, `bfBaroSample`. These are omitted from non-barometer builds.

Custom validity flags must be honored when interpreting unavailable/stale samples. Stock Explorer does not automatically mask every custom validity flag. Numeric placeholders in an invalid interval are **not measurements**.

## Verification and newly found gaps

- Native register-model tests cover I2C routing/open drain, repeated starts, writes, errors, timeout and ownership. Fake-bus BMP280 tests cover ID fallback, trim parsing, compensation, conversion timeout, freshness, reference establishment and altitude sign.
- Native encoder and real-FAT32 fixture tests cover 71/79-field files. Pinned, unmodified Explorer decodes 600 frames, gyro units, actual quaternion attitude, RSSI distinct from LQ, barometric altitude units, eRPM conversion and EOF. These are synthetic software fixtures, not recordings from the physical Matek.
- Audit caught an overlong field-name header and incorrect `BaroAlt` casing. Short custom names and the actual standard name `baroAlt` fix stock-reader compatibility.
- Legacy Explorer-computed `rcCommands[]` / `axisError[]` still use firmware-specific rate logic for unrecognized BobFlight. Plot recorded `setpoint[]` and `bfError[]`. Do not spoof Betaflight firmware identity. Full derived-field parity needs explicit viewer support or a separate proven compatibility approach.
- Both500/1000 Hz recording models pass at their existing1/4/8 kHz PID-loop scenarios after delta coding. The existing8 kHz PID/1 kHz recording case still honestly auto-lowers to500 Hz. The model is not a measured MCU CPU benchmark and does not establish real-time headroom for quaternion encoding or the new bus.
- Matek NOR remains discovery-only. Needed next: bounded page programming, address-mode handling, non-destructive storage/catalog design, download verification, and an actual sustained recording test. Never implicitly erase existing flash contents.

## References and licensing boundary

Implementations are independently authored from public register/protocol facts, not copied GPL implementations.

- Bosch BMP280 datasheet: https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp280-ds001.pdf
- ST RM0431, STM32F722/F723 peripheral registers.
- Board routing: Betaflight config `e1d87e7ecf6717bd3806a08400aeb892cd1d1fc3`, `configs/MTKS/MATEKF722HD/config.h`; Matek F722-PX manufacturer specification.
- Field/RSSI facts: Betaflight `4fc1520c5a5decddc8ef07ad57c0e766ea8747ba`, Blackbox field declarations and CRSF range constants.
- Test oracle: Blackbox Explorer `a84755c5e897c1a3a580424b64c0df066c12c6b4`, external checkout, not vendored into firmware.
