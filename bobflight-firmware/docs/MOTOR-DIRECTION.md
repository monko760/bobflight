<!-- Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 -->
# Motor direction (`motor_direction`, config schema 10, tentative)

`motor_direction` tells the mixer which way the props spin. It does **NOT** change the spin
direction in the ESC: the firmware sends no direction command to the ESCs, and the motors keep
spinning whichever way they were wired or set up in the ESC. If the setting does not match how
the props actually spin, yaw control is reversed, so do the bench test below before every first
flight after changing it.

| Token | Mixer yaw sign on the PID yaw output (M1 RR, M2 FR, M3 RL, M4 FL) |
|---|---|
| `props-out` (default) | `-1 +1 +1 -1`: exactly today's mixer, unchanged |
| `props-in` | `+1 -1 -1 +1`: the yaw term is negated on all four motors |

Roll, pitch, throttle, clamping and the idle floor are the same for both tokens. Only the yaw
term changes sign (`mixer_yaw_direction()` in `src/flight/mixer.c`).

## Default `props-out` = today's mixer yaw behaviour (verified)

At the base of this branch (`feat/rpm-filter`, 870e601), `src/flight/mixer.c` lines 52-56 are:

```
motor_out[0] = thr - roll + pitch - yaw; /* rear-right */
motor_out[1] = thr - roll - pitch + yaw; /* front-right */
motor_out[2] = thr + roll + pitch + yaw; /* rear-left */
motor_out[3] = thr + roll - pitch - yaw; /* front-left */
```

So today the yaw sign is M1 `-`, M2 `+`, M3 `+`, M4 `-`. With `props-out` the mixer multiplies the
PID yaw output by `+1` and these four lines are unchanged, so the output is bit-identical to the
base mixer. `host_mixer_direction` checks this for 4116 roll/pitch/yaw/throttle/min_throttle
cases with `memcmp` against a copy of the base formula, and checks the exact negation for
`props-in`. Existing quads keep exactly the yaw behaviour they fly with today, and migrated
configs get `props-out`.

**Why the name `props-out` (to confirm on hardware).** The repo does not state the gyro z sign.
The mixer comment says "+yaw CW looking down", but the same comment says "+pitch raises nose",
which does not match the pitch signs in those lines, so the comment cannot settle it. The yaw
controller is `pid_yaw = kp * (setpoint - gyro_z)`. *If* gyro z is positive for a
counter-clockwise rotation seen from above (right-hand rule, z up), then rotating the frame CW
by hand gives a positive PID yaw output, which speeds up M2 FR and M3 RL. For the controller to
resist that rotation, those motors must be the ones whose reaction torque turns the frame CCW,
so they must spin CW. FR and RL spinning CW is the "props out" layout. This depends on the gyro
z sign, which is not verified here. The bench test below settles it on each quad.

## Props-off yaw bench test (do this after any change)

props off, Acro, armed above 5% throttle: rotate the frame clockwise by hand and the clockwise-spinning motors should speed up

If the counter-clockwise-spinning motors speed up instead, `motor_direction` does not match the
props. Disarm, fix it, and test again. The `mixer` report shows which sign each motor gets.

## CLI

```
get motor_direction            ->  motor_direction=props-out|props-in
set motor_direction props-in   ->  ok motor_direction=props-in
mixer                          ->  read-only report (below)
```

`set motor_direction` is checked in this order and replies with exactly one of these lines:

| Condition | Reply (verbatim) |
|---|---|
| armed | `set failed: armed` (the existing line, the same for every key) |
| a motor test is running: `motor_test`, `motor_pulse`, `motor_seq`, a pending bench stop output, or the receiver switch bench enabled (`bench_motor_active()`) | `set failed: motor test running` |
| token is not exactly `props-out` or `props-in` (case-sensitive) | `set failed: motor_direction must be props-out or props-in` |
| missing value | `set failed` (the existing generic parser line) |
| accepted | `ok motor_direction=<token>` |

A refused set leaves the value unchanged. An accepted set applies at the next mixer call (no
reboot) and marks storage dirty. **Save to controller** keeps it after a reboot. The Configurator
follows every set with `get motor_direction` and then a re-read of the `mixer` report.
On the Motors tab these commands share the command gate with the eRPM poll. As for `motor_poles`
(#60), only the gate's own "another UI command is in flight; request not queued" refusal is retried
(nothing was sent), up to 30 tries 100 ms apart; an FC reply is never retried, so an accepted set is
never sent twice. If the gate stays busy, the value shows `unknown` with that message, never the
older-FC state; if only the `mixer` report stays refused, its cells show `unknown` with the same
message and the value the FC did answer stays visible.

`mixer` report (framed, frozen: exactly these lines in this order):

```
mixer_api: 1
mixer: quadx
motor_direction: props-out
mixer_yaw_m1: -1
mixer_yaw_m2: +1
mixer_yaw_m3: +1
mixer_yaw_m4: -1
mixer_end: 1
```

`diff` lists `set motor_direction props-in` only when it differs from the default. `dump` always
lists it (after `set motor_poles`). `defaults` resets it to `props-out`.

## Storage: schema 10 (tentative number)

- Payload 256 bytes (`MAX_PAYLOAD` 256): schema 9 bytes 0..223 unchanged, 224..227 reserved zero,
  **228..231 `motor_direction` u32 LE** (0 = props-out, 1 = props-in, anything else refuses the
  whole record), 232..255 reserved zero.
- Migration: a record from **any older schema** loads with `props-out`, written explicitly
  (`if (loaded_schema < MOTOR_DIRECTION_SCHEMA) put32(p + 228, props-out)`), and stays dirty
  until an explicit Save, like the earlier migrations.
- Storage `scope` and the export `# scope:` end with `,motor_poles,motor_direction`.

**If G1 lands first.** G1 (`gyro_rate_hz`, branch `feat/gyro-rate`) also calls itself schema 10
with the same 256-byte shape and puts `gyro_rate_hz` at 224..227, 228..255 reserved zero. That is
why `motor_direction` sits at 228 and 224..227 is left reserved here. If G1 merges first, this
change becomes **schema 11**: set `MOTOR_DIRECTION_SCHEMA` and `PERSIST_SCHEMA` to 11, add the
v11 store functions, narrow G1's reserved-zero check to 232..255, and append `motor_direction`
after G1's scope (Configurator `STORAGE_SCOPE_V11`). The migration needs no change: it keys on
`loaded_schema < MOTOR_DIRECTION_SCHEMA`, so a G1 schema 10 record (228..231 zero) also migrates
to `props-out`, and its `gyro_rate_hz` is kept. This combination is not built or tested here.

## Export size

The worst-case schema 10 `dump` (`host_storage_cli`: accel calibration printing all 9 `%.9g`
digits, `long_mode` HORIZON range, AUX12 mode rows, loop 8000, `props-in`) measures (it differs per board build):
**1858 bytes** on the host dummy board,
**1863 bytes** on tmotor_f7_v2 and **1875 bytes** on kakute_f7_hdv. The Configurator limit is
`CONFIG_EXPORT_MAX_BYTES` 2048, so the worst board leaves **173 bytes** of headroom. The test
prints the count and fails if `len + 64 > 2048` (or `len <= 1800`, so a broken dump cannot pass) or
the export reports `config export failed`. With G1 also merged, an estimated ~36 more bytes (one
`set gyro_rate_hz 8000` line plus its scope entry), about 1911 bytes on Kakute, still fits.

## Tests

- `mixer_direction` (C): bit-identical props-out, exact props-in negation, applies immediately,
  `mixer` report table, a PID-yaw bench analog, token parse/defaults.
- `motor_direction_cli_unit` (C): armed → `set failed: armed`, each motor-test source →
  `set failed: motor test running`, value unchanged after each refusal.
- `motor_direction_cli` (Python on the real `bobflight_host`): get/set/refusal lines, report,
  diff/dump/defaults, storage schema 10, save + reboot keeps `props-in`.
- `persist_config`, `legacy_p54_migration`, `config_store`, `storage_cli`: layout, migration from
  schema 9 and older, out-of-domain refusal, export bytes.

The bench test above has not been done on hardware for this change.
