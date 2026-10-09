# Blackbox log fields: BobFlight schema4

Current logs are self-describing71-field files, or79 fields when the barometer backend is compiled. Read names, signedness, predictors and encoding from the header. Configuration storage is schema13, distinct from this log schema. No old configuration migration or field-name aliases are provided.

See [compatibility and hardware limits](BLACKBOX-COMPATIBILITY.md). These are SD-backed files; Matek external NOR recording remains unsupported. Invalid-source placeholders are not measurements.

## Field layout

| Index | Field | Units / meaning |
|---|---|---|
| 0,1 | `loopIteration`, `time` | Actual PID iteration and session-relative microseconds |
| 2..4 | `gyroADC[0..2]` | Filtered gyro,0.1 degrees/s |
| 5..7 | `gyroUnfilt[0..2]` | Pre-filter, aligned/calibrated gyro,0.1 degrees/s |
| 8..11 | `setpoint[0..3]` | Angular demand in degrees/s; actual post-failsafe mixer throttle times1000 |
| 12..20 | `axisP/I/D[0..2]` | PID terms, normalized command times1000 |
| 21..23 | `bfOutput[0..2]` | Clamped PID output, normalized command times1000 |
| 24..27 | `motor[0..3]` | Requested DShot command:0 stop,48..2047 active; not measured motor speed |
| 28..31 | `rcCommand[0..3]` | Pilot roll/pitch/yaw times500; throttle1000+1000*normalized |
| 32..34 | `bfError[0..2]` | Actual setpoint minus gyro, rounded degrees/s |
| 35..37 | `bfArmed`, `bfMode`, `bfFailsafe` | Armed0/1; mode0 angle,1 acro,2 horizon; failsafe0 idle,1 hold,2 procedure |
| 38..40 | `bfDtUs`, `bfDropped`, `bfSchema` | PID interval microseconds, cumulative queued drop count, schema4 |
| 41..44 | `bfPidValid`, `bfGyroValid`, `bfRxFresh`, `bfOutputHealthy` | Per-source validity0/1 |
| 45..47 | `accSmooth[0..2]` | Body-frame acceleration,4096 counts/g |
| 48..50 | `imuQuaternion[0..2]` | Estimator attitude converted to signed Q15 quaternion xyz, positive-w hemisphere |
| 51,52 | `bfAccelValid`, `bfAttitudeValid` | Validity0/1; yaw is gyro-relative, not magnetic heading |
| 53..61 | `rssi`, `bfRssiDbm[0..1]`, `bfLinkQuality`, `bfLinkSnr`, `bfRxAntenna`, `bfRfMode`, `bfLinkAgeMs`, `bfLinkValid` | Selected CRSF dBm mapped from-130..0 to0..1023, raw dBm, actual LQ/SNR/antenna/mode and link-packet freshness; never substitute LQ for RSSI |
| 62..69, optional | `baroAlt`, `bfBaroTempCentiC`, `bfPressurePa`, `bfBaroReferencePa`, `bfBaroAgeMs`, `bfBaroValid`, `bfBaroAltValid`, `bfBaroSample` | Startup-relative altitude cm, temperature centi-C, pressure/reference Pa, age ms, valid flags and sample sequence |
| Final9 fields | `eRPM[0..3]`, `bfTelemOk`, `bfFilterFlags`, `bfEvents`, `bfLoopCode`, `bfOverruns` | Start at62 without barometer or70 with it. Meanings below |

### eRPM (`eRPM[0..3]`)

- The value is **electrical RPM divided by 100, truncated** (integer division). 12,399 eRPM logs as 123; anything below 100 eRPM logs as 0.
- Mechanical RPM = `eRPM[m] × 100 / (motor_poles / 2)`. `motor_poles` is in the header (standard `H motor_poles:` and `H BobFlight motor_poles:`). Mechanical Hz = that / 60. Stock Blackbox Explorer does this conversion itself from `H motor_poles:` (`eRPM × 200 / motor_poles` rpm).
- **0 means no valid telemetry for that motor.** A motor whose telemetry is not `OK` (bidirectional DShot off, timeout, CRC/GCR failure or stale) logs 0. A motor can be OK and still report 0 (stopped motor); `bfTelemOk` tells these apart.
- The source is the decoded bidirectional-DShot telemetry the RPM filter uses (`dshot_erpm()`), read once per logged frame.

### `bfTelemOk` bit order

Bit *m* = motor *m*+1 (`eRPM[m]`) had DShot telemetry status `OK` when the frame was built.

| bit | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| motor | 1 (`eRPM[0]`) | 2 | 3 | 4 |

Values range from 0 to 15. Bits 4–7 are always 0.

### `bfFilterFlags` bit order

| bits | meaning |
|---|---|
| 0 | manual gyro notch 1 running (`gyro_notch1_*` valid at the current filter rate) |
| 1 | manual gyro notch 2 running |
| 2 | RPM filter active (= reason code 3) |
| 3–4 | RPM filter reason: 0 `off` (harmonics 0), 1 `bidir-off`, 2 `erpm-unavailable`, 3 `ok` (the same codes and names as the `rpm_filter` CLI) |
| 5–6 | RPM harmonics active, 0..3. Only set while the RPM filter is active: the scheduled count (1 at 1 kHz, up to 3 at 4/8 kHz) |
| 7 | always 0 |

Decode: `notch1 = f & 1`, `notch2 = f >> 1 & 1`, `rpm = f >> 2 & 1`, `reason = f >> 3 & 3`, `harmonics = f >> 5 & 3`. Example: 125 = notch 1 on, notch 2 off, RPM active, reason `ok`, 3 harmonics.

The flags show the state the gyro path **last applied**. The logger reads it through read-only getters (`gyro_notch_active_snapshot()`, `rpm_filter_gyro_snapshot()`). Those getters never refresh or recompute filter coefficients, so logging cannot change filter timing.

### `bfEvents`: bits, latch and clear

| bit | event | set when (compared with the previous PID loop) |
|---|---|---|
| 0 | arm | armed went 0 → 1 |
| 1 | disarm | armed went 1 → 0 |
| 2 | failsafe stage change | `bfFailsafe` changed (either direction) |
| 3 | rx lost | receiver freshness went fresh → not fresh |
| 4 | mode change | effective flight mode changed |
| 5 | loop-rate change | target loop rate changed (see `bfLoopCode`) |
| 6 | telemetry capture fail | the bidirectional-DShot capture-failure latch went clear → set |
| 7 | always 0 | |

Latch and clear rules:

1. Edges are detected on **every PID loop**, including loops that are not logged because of decimation (for example 7 of every 8 loops at 4 kHz PID / 500 Hz log).
2. Each detected edge ORs its bit into a pending byte. The pending byte is written into the next frame that is **accepted into the log queue**, and then cleared. So a frame's `bfEvents` means "these transitions happened since the previous **logged** frame". Short transitions between two logged samples are not lost. A failsafe stage that goes up and back down within one interval shows bit 2 once.
3. If that frame is dropped (recorder queue full), the bits stay pending and go out with the next accepted frame.
4. The first PID loop of a session is the baseline. It never reports an event, so being armed or in failsafe at `blackbox start` does not show as a transition.
5. A bit means at least one such transition. It does not count them.

### `bfLoopCode` and `bfOverruns`

- `bfLoopCode` = target PID loop rate in Hz / 250: 4 = 1 kHz, 8 = 2 kHz, 16 = 4 kHz, 32 = 8 kHz. It is read every PID loop.
- The header's `looptime`, `H I interval` and `H BobFlight loop_rate_hz` describe the loop at session start. If the runtime overrun guard (`docs/LOOP-RATE.md`) lowers the loop rate during a session, the header goes stale. The change then shows as event bit 5 on the next logged frame, and `bfLoopCode` carries the new rate from then on. Readers should trust the per-frame loop code over the header. `time` and `bfDtUs` stay true timestamps in either case.
- 0 means unknown. Only host tests and other callers that pass no context produce it; production firmware always logs a non-zero code.
- `bfOverruns` = scheduler `overruns` (the since-boot counter used by `timing`) minus its value at the session's first PID loop. It is a monotonic session delta.

## Header and byte budget

The header identifies BobFlight honestly and includes `log_schema:4`, board, firmware version, loop/gyro/PID denominator, exact Actual rates, PID gains, filter settings, `motor_poles`, `acc_1G:4096`, and DShot output range. Use recorded `setpoint[]` and `bfError[]`, not Explorer's unsupported legacy-derived rate/error calculations for BobFlight.

The fixed128-byte rate block remains in sector0 for effective-rate updates without moving the rest of the file. Header buffer:5120 bytes; each line must fit the stock reader's1023-byte limit. Board identifiers are sanitized and capped at47 characters.

Worst case:1 tag +5 bytes per field,356 bytes for71 fields or396 for79. Both I and P encodings obey this bound. The existing64 KiB ring is unchanged. The non-barometer throughput model produces approximately74..76 bytes/frame, versus about105 for the expanded absolute-only records. These are synthetic model results, not physical card/MCU measurements.

Capture still decimates before expensive sample construction. Skipped PID loops update iteration/timing/events but do not manufacture logged samples. Existing125/250/500/1000 Hz recording rates remain separate from gyro/PID rates; the standard default is500 Hz. The project ceiling is2 kHz, not a claim that a2 kHz recording mode is implemented.

## Lossless session codec

Session files retain all71 fields (79 with barometer). The first record and at least every32nd record are absolute I anchors. Intermediate P records use standard predictor1 (previous field) and signed variable-byte encoding0. Differences outside int32 force an immediate absolute anchor instead of wrapping. Header I/P intervals describe this cadence; all timestamps and iteration counters remain their actual captured values. Failed encoding does not modify the destination or predictor state. A fresh session resets prediction.

Only one queued record is encoded per session-poll call, so the deadline-aware outer driver can reconsider its budget between records instead of processing a16-record trigonometry/encoding batch. This is bounded software work, not a measured physical-MCU timing guarantee. The SD throughput models and original loss/ring/latency assertions still apply.
