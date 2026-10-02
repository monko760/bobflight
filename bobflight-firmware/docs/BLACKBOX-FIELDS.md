# Blackbox log fields: BobFlight log schema 3

This page is the reference for the onboard `.BBL` files written by `blackbox start`. It covers the frame fields, units, bit orders, header keys and byte budget. Schema 3 is new in this change (it replaces schema 2). The encoder is original BobFlight code (`src/flight/blackbox_encode.c`) for the publicly readable Blackbox wire format. Every frame is a self-contained `I` frame: no `P` deltas and no predictors.

No CLI key or `blackbox status` key changed with schema 3 (`blackbox_api` stays 2).

## Frame layout (54 fields)

Signed fields use zigzag varints; unsigned fields use plain varints (`H Field I signed` / `H Field I encoding` in the header say which is which).

| # | Field | Type | Units / meaning |
|---|---|---|---|
| 0 | `loopIteration` | u | PID-loop counter since `blackbox start` (counts every PID loop, logged or not) |
| 1 | `time` | u | µs since the session epoch |
| 2–4 | `gyroADC[0..2]` | s | filtered gyro, 0.1 °/s |
| 5–7 | `bobflightRawGyro[0..2]` | s | pre-filter, board-aligned, calibrated gyro, 0.1 °/s |
| 8–10 | `setpoint[0..2]` | s | commanded rate, °/s (rounded) |
| 11 | `setpoint[3]` | s | throttle, normalized × 1000 |
| 12–20 | `axisP/I/D[0..2]` | s | PID terms, normalized command × 1000 |
| 21–23 | `bobflightOutput[0..2]` | s | clamped PID output, normalized command × 1000 |
| 24–27 | `motor[0..3]` | s | requested DShot throttle (0 stop, 48..2047) |
| 28–31 | `rcCommand[0..3]` | s | roll/pitch/yaw × 500; throttle 1000 + 1000 × normalized |
| 32–34 | `bobflightError[0..2]` | s | setpoint − gyro, °/s |
| 35 | `bobflightArmed` | u | 0/1 |
| 36 | `bobflightMode` | u | effective control mode: 0 angle, 1 acro, 2 horizon |
| 37 | `bobflightFailsafe` | u | failsafe stage: 0 idle, 1 hold, 2 procedure |
| 38 | `bobflightDtUs` | u | µs since the previous PID loop (0 on the first) |
| 39 | `bobflightDropped` | u | cumulative recorder drops when this frame was queued |
| 40 | `bobflightSchema` | u | **3** |
| 41–44 | `bobflightPidValid`, `GyroValid`, `RxFresh`, `OutputHealthy` | u | 0/1 validity flags |
| 45–48 | `eRPM[0..3]` | u | **eRPM / 100** per motor (new) |
| 49 | `bobflightTelemOk` | u | 4-bit telemetry-OK mask (new) |
| 50 | `bobflightFilterFlags` | u | 7-bit filter state (new) |
| 51 | `bobflightEvents` | u | 7-bit latched events (new) |
| 52 | `bobflightLoopCode` | u | target loop Hz / 250 (new) |
| 53 | `bobflightOverruns` | u | scheduler overruns since the session's first PID loop (new) |

### eRPM (`eRPM[0..3]`)

- The value is **electrical RPM divided by 100, truncated** (integer division). 12,399 eRPM logs as 123; anything below 100 eRPM logs as 0.
- Mechanical RPM = `eRPM[m] × 100 / (motor_poles / 2)`. `motor_poles` is in the header. Mechanical Hz = that / 60.
- **0 means no valid telemetry for that motor.** A motor whose telemetry is not `OK` (bidirectional DShot off, timeout, CRC/GCR failure or stale) logs 0. A motor can be OK and still report 0 (stopped motor); `bobflightTelemOk` tells these apart.
- The source is the decoded bidirectional-DShot telemetry the RPM filter uses (`dshot_erpm()`), read once per logged frame.

### `bobflightTelemOk` bit order

Bit *m* = motor *m*+1 (`eRPM[m]`) had DShot telemetry status `OK` when the frame was built.

| bit | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| motor | 1 (`eRPM[0]`) | 2 | 3 | 4 |

Values range from 0 to 15. Bits 4–7 are always 0.

### `bobflightFilterFlags` bit order

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

### `bobflightEvents`: bits, latch and clear

| bit | event | set when (compared with the previous PID loop) |
|---|---|---|
| 0 | arm | armed went 0 → 1 |
| 1 | disarm | armed went 1 → 0 |
| 2 | failsafe stage change | `bobflightFailsafe` changed (either direction) |
| 3 | rx lost | receiver freshness went fresh → not fresh |
| 4 | mode change | effective flight mode changed |
| 5 | loop-rate change | target loop rate changed (see `bobflightLoopCode`) |
| 6 | telemetry capture fail | the bidirectional-DShot capture-failure latch went clear → set |
| 7 | always 0 | |

Latch and clear rules:

1. Edges are detected on **every PID loop**, including loops that are not logged because of decimation (for example 7 of every 8 loops at 4 kHz PID / 500 Hz log).
2. Each detected edge ORs its bit into a pending byte. The pending byte is written into the next frame that is **accepted into the log queue**, and then cleared. So a frame's `bobflightEvents` means "these transitions happened since the previous **logged** frame". Short transitions between two logged samples are not lost. A failsafe stage that goes up and back down within one interval shows bit 2 once.
3. If that frame is dropped (recorder queue full), the bits stay pending and go out with the next accepted frame.
4. The first PID loop of a session is the baseline. It never reports an event, so being armed or in failsafe at `blackbox start` does not show as a transition.
5. A bit means at least one such transition. It does not count them.

### `bobflightLoopCode` and `bobflightOverruns`

- `bobflightLoopCode` = target PID loop rate in Hz / 250: 4 = 1 kHz, 8 = 2 kHz, 16 = 4 kHz, 32 = 8 kHz. It is read every PID loop.
- The header's `looptime`, `H I interval` and `H BobFlight loop_rate_hz` describe the loop at session start. If the runtime overrun guard (`docs/LOOP-RATE.md`) lowers the loop rate during a session, the header goes stale. The change then shows as event bit 5 on the next logged frame, and `bobflightLoopCode` carries the new rate from then on. Readers should trust the per-frame loop code over the header. `time` and `bobflightDtUs` stay true timestamps in either case.
- 0 means unknown. Only host tests and other callers that pass no context produce it; production firmware always logs a non-zero code.
- `bobflightOverruns` = scheduler `overruns` (the since-boot counter used by `timing`) minus its value at the session's first PID loop. It is a monotonic session delta.

## Header keys (schema 3)

The file keeps its existing header lines, including the fixed 128-byte rate block in sector 0 that is patched in place on an auto-lower (`docs/BLACKBOX-THROUGHPUT.md`). Schema 3 adds the following lines after the PID gains:

```
H BobFlight log_schema:3
H BobFlight board:<board id>
H BobFlight fw_version:<firmware version string>
H BobFlight loop_rate_hz:<pid hz> gyro_hz:<gyro hz> pid_denom:<denom>
H BobFlight gyro_lpf_hz:<v>
H BobFlight gyro_notch1_hz:<v>
H BobFlight gyro_notch1_cutoff_hz:<v>
H BobFlight gyro_notch2_hz:<v>
H BobFlight gyro_notch2_cutoff_hz:<v>
H BobFlight rpm_filter_harmonics:<v>
H BobFlight rpm_filter_min_hz:<v>
H BobFlight rpm_filter_q_x100:<v>
H BobFlight motor_poles:<v>
H BobFlight units:...;eRPM=eRPM/100;events,flags=bits(docs/BLACKBOX-FIELDS.md)
```

- **board**: the board id (`kakute_f7_hdv`, `tmotor_f7_v2`, `dummy`). Characters outside `[A-Za-z0-9._-]` become `_`. The value is capped at 47 characters and is `unknown` if empty. It is informational and never blocks a log.
- **fw_version**: the same string as `version` and `H Firmware revision:BobFlight <version>`. It is repeated under a BobFlight key so tools do not need to strip the prefix.
- **log_schema**: `3`. Every frame also carries `bobflightSchema = 3`.
- **loop_rate_hz / gyro_hz / pid_denom**: the scheduler at session start. See the loop-code note above for changes during a session.
- **Filter settings**: the saved/runtime values at session start. Configuration writes are refused while recording, so these values hold for the whole file. RPM `q_x100` is Q × 100, as in the CLI.
- The worst-case header (95-character version, long board id, widest numbers) is 3,273 B. The session header buffer is 4,096 B (host test `blackbox_encode`). A typical header is about 2.9 KiB.

## Byte budget

The worst-case bound is 1 tag byte + 54 fields × 5 bytes (a 32-bit varint carries 7 payload bits per byte) = **271 B**. `BLACKBOX_FRAME_MAX_BYTES` is that value. The session's encode buffer is sized from it, and static assertions check it is ≥ the frame bound, ≥ the 13-byte end marker and < 1/4 of the 64 KiB ring. The widest frame any valid sample can produce is 192 B (host test). The previous fixed 256 B buffer was below the proven bound.

Typical flight-like frame (host model values, 1 kHz loop, 500 Hz log):

| Field group | Fields | Typical bytes |
|---|---|---|
| tag `I` | – | 1 |
| `loopIteration`, `time` | 2 | 6.1 |
| `gyroADC`, `bobflightRawGyro` | 6 | 11.8 |
| `setpoint[0..3]` | 4 | 6.6 |
| `axisP/I/D`, `bobflightOutput` | 12 | 13.1 |
| `motor[0..3]` | 4 | 8.0 |
| `rcCommand[0..3]` | 4 | 7.2 |
| `bobflightError` | 3 | 3.0 |
| state, dt, dropped, schema, validity flags | 10 | 11.0 |
| **schema 3 additions**: `eRPM[0..3]` (12–30 k eRPM) | 4 | 7.5 |
| **schema 3 additions**: telem ok, filter flags, events, loop code, overruns | 5 | 5.0 |
| **Total** | 54 | **≈ 80–82 B** (schema 2: ≈ 70.7 B) |

| Log rate | Schema 3 bandwidth | 512 B data sectors/s |
|---|---|---|
| 500 Hz | ≈ 40 KiB/s | ≈ 79 |
| 1000 Hz | ≈ 80 KiB/s | ≈ 159 |

Measured in `bobflight_blackbox_throughput_test`: 81.0 B/frame at 1000/1, 81.7 B at 8000/2 and 81.0 B at 8000/1 (500 Hz). The drop matrix per loop rate is in `docs/BLACKBOX-THROUGHPUT.md`.

## Capture cost: decimate first

`bb_capture_observe_ex()` runs every PID loop. In order, it:

1. Updates the iteration counter and timing.
2. Detects event edges.
3. Calls `recorder_skip_if_not_due()`.

If the slot is not due, it returns there: no sample is built, no PID trace is copied, and no eRPM, telemetry or filter state is read. A skipped loop is counted exactly as `recorder_capture()` would count it (`total_attempted` and `total_skipped`; host test `recorder`). At 8 kHz PID with 500 Hz logging, 15 of every 16 loops now cost only the counters and edge checks.

One counting difference is deliberate: a loop that is not due is no longer validated. `blackbox_invalid` therefore counts invalid samples only in slots that would actually have been logged.

## Upgrade note (schema 2 → 3)

- **Field count is 46 → 54.** The duplicate `bobflightIteration` (schema 2 field 40, identical to `loopIteration`) is **removed**, and the nine new fields are appended after `bobflightOutputHealthy`.
- **Only fields 0–39 keep their positions.** Removing field 40 moves every later schema 2 field down by one:

  | Field | Schema 2 # | Schema 3 # |
  |---|---|---|
  | `loopIteration` … `bobflightDropped` | 0–39 | 0–39 (unchanged) |
  | `bobflightIteration` | 40 | removed |
  | `bobflightSchema` | 41 | 40 |
  | `bobflightPidValid` | 42 | 41 |
  | `bobflightGyroValid` | 43 | 42 |
  | `bobflightRxFresh` | 44 | 43 |
  | `bobflightOutputHealthy` | 45 | 44 |
  | `eRPM[0..3]` … `bobflightOverruns` (new) | — | 45–53 |

  Names, signedness and units are unchanged for every field that stays. A decoder that reads fields by position breaks from field 40 on: it would read `bobflightSchema` as `bobflightIteration` and every validity flag one slot off. Look fields up by name from the `H Field I name` header list (as Explorer does); such decoders keep working.
- `bobflightSchema` is now 3, and the header carries `H BobFlight log_schema:3`. Check the header key, or the first frame, before you interpret the new fields.
- New header keys: board, fw_version, loop/gyro/denom and filter settings (listed above). Existing header lines and the 128-byte rate block are unchanged.
- **Unchanged**: CLI keys, `blackbox status` (api 2) keys and values, the recorder rates (125/250/500/1000 Hz, default 500), the 64 KiB ring and file naming. The firmware version string is also unchanged in this change: tell builds apart by `H BobFlight log_schema:3`.
- **Auto-rate fix**: the 1 % drop threshold is now measured against **due logging slots**, not against every PID loop. Before, at 8 kHz PID / 500 Hz, the threshold was effectively about 16 % of frames, so a struggling card kept dropping for longer before the rate halved. At a 1 kHz loop with 500 Hz logging it was 2 % of frames; it is now 1 %.
- The repository's Explorer oracle script (`tests/verify_blackbox_explorer.cjs`) now expects 54 fields and schema 3. The in-repo clean-room decoder test (`tests/host_blackbox_decode.py`, CTest `blackbox_schema3_decode`) checks the header keys and all schema 3 fields round-trip.
