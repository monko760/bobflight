# Manual gyro notches (config schema 8)

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Two static notch filters on the gyro, applied after the gyro LPF on all three axes, before
PID and blackbox. Manual only: no dynamic or RPM tracking.

## Settings (persisted, schema 8, payload 208 bytes)

| key | meaning | rule |
|---|---|---|
| `gyro_notch1_hz`, `gyro_notch2_hz` | centre frequency | `0` = off, else `20..1000` Hz |
| `gyro_notch1_cutoff_hz`, `gyro_notch2_cutoff_hz` | lower -3 dB edge | `0 < cutoff < centre`; while the centre is 0: `0..<1000` (kept) |

Defaults are 0 (both notches off). An older image (schema < 8) migrates with both notches off.
`get`/`diff`/`dump`/`defaults`/`save` follow `gyro_lpf_hz` (`%.6g`). `diff`/`dump` list the
cutoff before the centre so a replayed export always passes the pair rule.

### `set` checks (the firmware is the authority)

* Pair rule on every `set`. A nonzero centre needs its cutoff first
  (`set failed: gyro_notchN_hz needs 0 < gyro_notchN_cutoff_hz < gyro_notchN_hz (set the cutoff first)`).
* A nonzero centre must be below 0.45 × the **running** gyro-filter rate
  (`set failed: gyro_notchN_hz must be below 450 Hz at the running 1000 Hz loop rate`).
  The check uses the rate that is running now, not a pending `loop_rate_hz`.
  Since safety S1 the gyro filter runs on every gyro sample, so this rate is
  the gyro rate (8000 on the default Kakute 8000/2 profile, was 4000); see
  `docs/SAFETY-NOISE.md`.
* A refused `set` changes nothing. `set` is refused while armed.

### Runtime guard

Coefficients are recomputed only when a setting or the filter dt changes. If a stored centre
is at or above 0.45 × the actual rate (e.g. a 600 Hz notch saved at 4 kHz, then
`loop_rate_hz 1000` + reboot), that notch is disabled at runtime and reported as
`above-nyquist`. The stored setting is not changed and storage stays clean.

## `filters` (read-only report)

```
filters_api: 1
filters_sample_hz: <actual gyro-filter rate, Hz>
gyro_notch1_active: yes|no
gyro_notch1_reason: off|ok|above-nyquist|invalid
gyro_notch2_active: yes|no
gyro_notch2_reason: off|ok|above-nyquist|invalid
filters_end: 1
```

An older image answers `unknown — try help` and `get gyro_notch1_hz` answers `unknown key`;
the Configurator then shows the rows as unknown.

## DSP

RBJ biquad notch (transposed direct form II, float). Q comes from the analog relation
`Q = f0·fc / (f0² − fc²)`, with fc the lower -3 dB edge. The bilinear transform warps the band
near Nyquist, so at 1 kHz the band gets narrower (measured lower edge −0.44 … −2.7 dB instead
of −3 dB); at 4k/8k the edge is −1.7 … −3.0 dB. The centre depth is 77–145 dB and the response
is within 1 dB well outside the band (tests/host_filter_notch.c at 1k/4k/8k). A notch is
primed to steady state when it (re)starts, so there is no step transient. Non-finite samples
are skipped.

Cost (arm-none-eabi-gcc -O2, Cortex-M7 FPv5-SP): about 25 instructions per notch per axis
(5 FMA/MUL/ADD, 5 coefficient loads, 2 state loads/stores, finite check). Estimate: ~30 cycles
per notch per axis, so ~180–220 cycles per gyro sample with both notches on (≈1 µs at 216 MHz,
under 1 % of the 125 µs 8 kHz slot). Recomputing (sinf/cosf) runs only on a setting or dt
change: a `set` (refused while armed), boot, or the loop-rate overrun guard lowering the rate
(which can happen in flight). That one sample costs extra (estimated a few thousand cycles),
and it lands on the first sample at the lower, longer-slot rate. This is an estimate, not a
measurement on hardware.

If the overrun guard steps a 4 kHz loop down to 1 kHz in flight, a notch at 450 Hz or above
becomes `above-nyquist`: it is switched off and reported, and the setting is kept.

The host build's gyro path is a bit-exact passthrough, so the host CLI tests cover the
contract and the runtime guard, and the DSP is covered by the unit test only.
