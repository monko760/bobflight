# RPM notch filter (config schema 9)

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Per-motor notch filters on the gyro that follow each motor's rotation frequency, measured by
bidirectional DShot eRPM telemetry. They run after the gyro LPF and the manual notches
([GYRO-NOTCH.md](GYRO-NOTCH.md)), before PID and blackbox, on all three axes. Clean-room
implementation (RBJ cookbook notch); no Betaflight source.

## Settings (persisted, schema 9, payload 224 bytes)

| key | meaning | rule (integer) | default |
|---|---|---|---|
| `rpm_filter_harmonics` | notches per motor: 1 = fundamental, 2 = + 2×, 3 = + 3× | `0..3`, `0` = off | `0` |
| `rpm_filter_min_hz` | lowest notch frequency; slower motors hold the notch here | `50..200` Hz | `100` |
| `rpm_filter_q_x100` | notch Q × 100 (same for every notch) | `100..1000` (Q 1.00–10.00) | `500` |
| `motor_poles` | magnetic poles of all four motors (eRPM → mechanical Hz) | even, `4..36` | `14` |

The filter is **off by default**, and it never turns on bidirectional DShot. `dshot_bidir` stays a
separate explicit setting. Older images (schema < 9) migrate to the defaults and stay dirty until an
explicit Save. `get`/`diff`/`dump`/`defaults`/`save` work like the other float settings.

### `set` replies (the firmware is the authority)

```
ok rpm_filter_harmonics=2
set failed: rpm_filter_harmonics must be 0..3
set failed: rpm_filter_min_hz must be 50..200
set failed: rpm_filter_q_x100 must be 100..1000
set failed: motor_poles must be even, 4..36
set failed                      (not a number, or not a whole number)
set failed: armed               (the existing check for every setting)
```

A refused set leaves the value unchanged. Every setting applies on the next filter update (no
reboot). **`motor_poles` decision:** it is a normal persisted setting, refused while armed like
every setting, applied at the next update, and edited on the Configurator **Motors** tab (the
Filters tab shows it read-only). On firmware without the key, the Motors tab keeps its old
browser-only preference.

## `rpm_filter` report

Frozen by the Configurator Lead: exactly these lines, in this order.

```
rpm_filter_api: 1
rpm_filter_active: yes
rpm_filter_reason: ok
rpm_filter_sample_hz: 4000
rpm_filter_harmonics_active: 3
rpm_filter_m1_hz: 180
rpm_filter_m2_hz: 182
rpm_filter_m3_hz: 179
rpm_filter_m4_hz: 185
rpm_filter_end: 1
```

* `rpm_filter_active`: `yes` if and only if the reason is `ok`.
* `rpm_filter_sample_hz`: the filter rate running now (the loop rate).
* `rpm_filter_harmonics_active`: harmonics that run after the loop-rate trim (0 unless the reason is `ok`).
  The setting itself is not in the report; read it with `get rpm_filter_harmonics`.
* `rpm_filter_reason`, highest precedence first:
  * `off`: harmonics 0.
  * `bidir-off`: `dshot_bidir` is off.
  * `erpm-unavailable`: bidir on, but no motor has telem `ok` with eRPM > 0.
  * `ok`: at least one motor is tracked.
* `rpm_filter_mN_hz`: the fundamental the notches use for motor N, rounded to whole Hz
  (`max(min_hz, eRPM / (poles/2) / 60)`), or `unavailable` when that motor has no valid eRPM or
  the reason is not `ok`. The Configurator shows these tokens as sent and never computes Hz from
  `erpm_mN`.

## DSP

* Fundamental `f = eRPM / (motor_poles / 2) / 60`. Notch `h` sits at `h × max(min_hz, f)`, with Q = `rpm_filter_q_x100 / 100`.
* RBJ notch biquad per motor × harmonic × axis (up to 4 × 3 × 3 = 36).
* Coefficients use one `sinf`/`cosf` per motor. Harmonics 2 and 3 come from the Chebyshev
  recurrence (no further trig).
* **Trim:** harmonic `h` is used only if `h × 400 Hz < 0.45 × fs`. 400 Hz is the static design
  ceiling for the fundamental (24 000 mechanical RPM). This gives 1 harmonic at 1 kHz, 3 at 4 kHz
  and 3 at 8 kHz. The report shows the result as `harmonics_active`.
* **Runtime bypass:** any single notch at or above `0.45 × fs` fades out (it is not reported
  separately).
* **Round-robin:** coefficients for one motor are recomputed per filter sample. All motors are
  recomputed when dt or a setting changes, and a motor whose notch starts is recomputed at once.
* **Fade:** each notch crossfades in or out over 2 ms (`y = x + w·(notch(x) − x)`). A notch
  starting from bypass is primed so it does not ring, and a fading-out notch keeps its last
  coefficients. Non-finite axes are skipped.
* **Timing:** runs in task context from `gyro_filter()`, using the eRPM decoded in the previous
  cycle's DShot write (one frame late, never blocking). The CLI report refreshes the same state with
  the gyro's exact dt. The cooperative scheduler never lets the two preempt each other.
* **Host builds:** the gyro path stays a bit-exact passthrough, so the DSP is covered by
  `tests/host_rpm_filter.c` only.

### Cycle estimate (STM32F7 @ 216 MHz, not measured)

* Apply: 36 biquads + crossfade ≈ 540 cycles.
* One round-robin motor update ≈ 500 cycles.
* Total ≈ 1100–1300 cycles ≈ 5–6 µs, about 2.4 % of a 4 kHz slot.
* A dt or setting change recomputes all motors once (≈ 2000-cycle spike).
* Estimate only. No hardware measurement has been made.

## Export size

Schema 10 adds `motor_direction` (worst case 1875 bytes on kakute_f7_hdv, see [MOTOR-DIRECTION.md](MOTOR-DIRECTION.md)). A schema 9 `dump` with realistic calibration (`%.9g`) is about 1810 bytes. The export buffer and the
Configurator's `CONFIG_EXPORT_MAX_BYTES` are **2048** bytes (was 1800); `tests/host_storage_cli.c`
checks a calibrated worst case above 1800 and at most 2047 bytes. The uncalibrated worst case measured
1719, 1744 and 1731 bytes (dummy, kakute, tmotor).

**Older Configurators:** a Configurator released before schema 9 accepts only schema 1–8 exports, so it
rejects **every** schema 9 `diff`/`dump`, whatever its size. Upgrade the Configurator before exporting
from schema 9 FW.

## Risks and limits

* The static 400 Hz ceiling trims harmonics at 1 kHz even for slower motors.
* A per-notch runtime bypass is not reported.
* During the fade-out window a notch keeps its last frequency.
* No flight or bench measurement has been made (host passthrough, DSP unit-tested only).
* Flashing is held.
