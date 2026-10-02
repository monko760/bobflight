# Gyro sanity: stuck output, WHO_AM_I / config readback, saturation counter

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

No new setting. Two new `status` lines sit directly after `gyro_ok`:

```
gyro_ok: yes|no
gyro_health: ok|stuck|whoami-mismatch|config-lost
gyro_sat_count: <unsigned decimal, since boot>
```

## Rules

- **stuck** — the raw gyro output is unchanged on **all three axes** for more than
  50 ms of the millisecond clock (`GYRO_STUCK_MS`; so at least 50 ms) **while armed**.
  "Unchanged" means every fresh raw sample equals the first sample of the window on
  x, y and z; any change on any axis restarts the window. Detection runs only while
  armed and the window restarts on disarm, so a disarmed board resting on the bench
  reads `ok`. A sample re-used because data-ready was not set is not a new raw sample.
  At 8 kHz that is ~400 identical samples, at 1 kHz ~50; a working MEMS gyro on a
  running quad always shows noise in the low bits.
- **whoami-mismatch** — a periodic chip-ID read (WHO_AM_I `0x75`, or BMI270 CHIP_ID
  `0x00`) returns a different ID from the one seen at probe, or the read fails.
- **config-lost** — MPU6000-class only: a periodic readback of a register that
  `gyro_init` writes and already verifies at boot differs from that verified value,
  or the read fails: PWR_MGMT_1 `0x6B` = `0x01`, SMPLRT_DIV `0x19` = `0x00`, CONFIG
  `0x1A` = DLPF_CFG for the running output rate (`0` at 8 kHz, `3` at 1 kHz),
  GYRO_CONFIG `0x1B` = `0x18`, ACCEL_CONFIG `0x1C` = `0x10`. No other registers or
  values are used. ICM-42688 and BMI270 get the chip-ID check only (their init does
  not verify configuration readback, and neither can arm today). If the boot-time
  output-rate switch failed (`config_ok` false), only the chip ID is checked.
- **Saturation** — a fresh raw sample with any axis at full scale (`INT16_MIN` or
  `INT16_MAX`) adds one to `gyro_sat_count`. It is **only counted, never disarms**.
  The counter is 64-bit and printed in decimal (no `%llu`), so it does not wrap in
  any realistic uptime; the Configurator shows it verbatim.

## Effect of a non-ok health

Any non-ok health marks the gyro invalid: `gyro_is_healthy()` becomes false and
`arming_set_gyro_healthy(false)` is called. That is the **existing** invalid-gyro
path: an armed craft disarms (the mixer writes DShot 0), `gyro_sample()` fails so
`loop_gyro` keeps it disarmed, and arming is refused. `status` prints `gyro_ok: no`
whenever `gyro_health` is not `ok` (the three lines come from one function,
`gyro_status_lines()`, locked by the `gyro_health` host test).

`gyro_ok` is `yes` only when the gyro is valid **and** `gyro_health` is `ok`. A gyro
that was not found or failed its checks at boot (the existing invalid-gyro state, e.g.
the host build or an unbound gyro) prints `gyro_ok: no` with `gyro_health: ok`: the
runtime checks only run on a gyro that passed its boot probe, so they have found no
fault. The `gyro_health` test locks both cases.

## Latch until reboot (chosen) vs clear

The fault **latches until reboot** (`gyro_init`). Reasons:

1. Each condition means the sensor or its bus misbehaved in a way the firmware
   cannot recover from safely mid-session: a stuck output or a wrong ID points at a
   bus/sensor fault, and a lost configuration register means the part reset
   (e.g. a brown-out) and now runs at power-on defaults (different full-scale range
   and output rate), so its data is wrongly scaled until it is configured again.
   Re-configuring needs the blocking init sequence (reset plus 100 ms delays), which
   must not run in the 8 kHz loop.
2. Clearing automatically would let the craft be re-armed on a sensor that just
   failed, with no record of why. A latched fault stays visible in `status`
   (`gyro_health`) until the user power-cycles and the sensor is probed, verified
   and calibrated again.
3. It matches the existing behaviour: an SPI sample-read failure already leaves the
   gyro unhealthy until reboot.

## Bounded SPI work

The periodic check runs only from the background path (`cli_poll`, inside
`bg_cli_poll`), never in the gyro/PID cascade. Each call reads **one** register
(a single 2-byte transfer, 3 bytes for BMI270), **at most every 100 ms**
(`GYRO_HEALTH_PERIOD_MS`; a full MPU6000 cycle of six registers takes ~600 ms), and
only when `scheduler_bg_budget_us()` reports at least 60 µs before the next gyro slot
(`GYRO_HEALTH_MIN_BUDGET_US`); otherwise it retries on a later background pass.
Every SPI wait in the HAL is bounded. MPU6000 configuration registers may only be
read at up to 1 MHz (PS-MPU-6000A-00), so on the 8 kHz path the check drops the SPI
clock to the register clock for that one transfer and restores the 20 MHz sensor
clock afterwards (the host test asserts no configuration read happens on the fast
clock). The stuck check and saturation counter are a few compares per sample and
add no SPI traffic.

## Tests

`ctest -R gyro_health` (real `gyro.c` + real `arming.c`, MPU6000-class register
mock): disarmed 2 s of identical raw stays ok; armed 50 ms ok / 51 ms stuck with
disarm, `gyro_ok: no` and arming refused; latch survives moving data, disarm and
polls; re-init clears; one moving axis, a changed sample and a disarm each restart
the window; data-ready re-use is not a stuck vote; saturation counts on either rail,
armed or not, without disarming; `gyro_sat_count` prints 2^32 and 2^64-1 exactly;
WHO_AM_I mismatch and a failed check transfer latch `whoami-mismatch`; each of the
five configuration registers latches `config-lost`; polls are budget-gated,
rate-limited and one transfer each; on the 8 kHz board config reads use the 1 MHz
clock; ICM-42688 checks the chip ID only (on tmotor_f7_v2, which binds the MPU6000
revision only, an ICM ID stays unbound); a gyro not found at init prints `gyro_ok: no`
with `gyro_health: ok`. The test runs on dummy, kakute_f7_hdv and tmotor_f7_v2.

## Configurator (Setup page)

Two cards, `gyro_health` and `gyro_sat_count`, sit directly after the `gyro_ok` /
`gyro_bind` cards in the Setup status grid. They come from the Setup page's live
1 s `status` poll (the same read-only poll as the loop-rate readout), so a fault
that latches mid-session shows within about a second without pressing Refresh.

- Both values are shown exactly as the firmware sent them, including a health token
  this Configurator does not know (a newer firmware may add one).
- `gyro_sat_count` is shown digit for digit when it is an unsigned decimal of any
  length; it never goes through `Number()`, so values above 2^32 (or 2^53) are not
  rounded. Anything else, a missing key, an empty value or a key sent twice shows
  `unknown`. Disconnected, or no current poll reading, shows `unknown`.
- The cards gate nothing. Arming is blocked by the existing Arm gate because the
  firmware prints `gyro_ok: no` for any non-ok health.
- Mocks (`GYRO_HEALTH_MOCK_SCENARIOS`): `missing` (older FC, default), `ok`, `stuck`,
  `whoami-mismatch`, `config-lost`, `unknown-token` (`bias-drift`) and `sat-big`
  (`18446744073709551615`). Every non-ok scenario also makes the mock print
  `gyro_ok: no` and refuse `arm`, as the firmware does.
- Tests: `npm --prefix ui run test:gyro-health` (renderToStaticMarkup cards per mock,
  malformed values, the real SetupPage in the fake DOM: card order, live re-read of a
  mid-session fault, older FC, disconnected) and `.github/scripts/gyro-status-contract.cjs`
  (real Kakute and tmotor host `status` -> Setup view model, key order, token list).
