# BobFlight flight stack

Owned Path B modules under `src/flight/`. Apache-2.0. No Betaflight / INAV / Emu source.

## Modules

| Module | Role |
|--------|------|
| `rates` | RC sticks → rate setpoints (°/s) |
| `pid` | Rate PID roll/pitch/yaw |
| `mixer` | QUADX → 4 motor commands `[0,1]` |
| `arming` | Arm / disarm gates |
| `failsafe` | RX loss → disarm |
| `filter` | Soft 1st-order LPF (gyro + D-term) |

Cascade (Lead/`sched`): gyro → filter → rates+pid → mixer → `dshot_write`. Motors are forced to **0** unless `arming_state() == ARM_ARMED` and failsafe is inactive.

## Rates

- Caps / expo from runtime config (`config_get()`), CLI keys below. Fallback cap `RATES_MAX_DPS` = 800.
- Deadband: `0.02` stick units around center (noise → 0), then rescale to full throw.
- Curve: expo via `rates_curve_map()` — soft center; full stick → ±`rate_max_*`; odd-symmetric.
- Null `rc` in `rates_update` zeros setpoints.
- Host unit test: `bobflight_rates_math_test` / `scripts/test_flight_host_math.sh`.

## PID + rates CLI keys (`flight/config`)

Live gains — `pid_update` / `rates_update` read `config_get()` each tick.

| Key | Default | Notes |
|-----|---------|-------|
| `rate_max_roll` / `pitch` / `yaw` | `800` | deg/s full stick |
| `rate_expo` | `0.30` | 0 = linear, 1 = max expo |
| `pid_roll_p` / `i` / `d` | `0.002` / `0.001` / `0.00005` | roll axis |
| `pid_pitch_p` / `i` / `d` | same | pitch axis |
| `pid_yaw_p` / `i` | same P/I | yaw D reuses `pid_roll_d` (MVP) |
| `gyro_lpf_hz` | `320` | soft gyro LPF; `0`=off |
| `dterm_lpf_hz` | `53` | soft D-term LPF; `0`=off |

Also: DT `1/4000`, I limit `±50`, output clamp `±0.4` with conditional I anti-windup.

AirMode (`airmode` 0/1, default **0**): when off, low throttle (`<0.05`) resets I while armed; when on, I keeps integrating at idle. Always resets on disarm.

Min throttle (`min_throttle` 0..0.2, default **0.05**): armed mixer floor (stick + post-mix). Independent of `ARMING_THROTTLE_MAX` arm gate. Disarmed motors forced to 0 in the task loop. CLI: `get` / `set` / `save` / `defaults` (`scripts/test_cli_config.sh`).


## Soft LPF (`flight/filter`) — Filters R0

First-order low-pass used by soft gyro filtering (`gyro_filter` via `loop_filter`) and PID D-term:

```
tau   = 1 / (2 * pi * fc)
alpha = dt / (tau + dt)
y[n]  = y[n-1] + alpha * (x[n] - y[n-1])
```

`fc_hz = 0` disables the filter (passthrough, alpha = 1). No notches / dyn / RPM / HW gyro DLPF register writes in this increment.

| Key | Default | Range | Continuity note |
|-----|---------|-------|-----------------|
| `gyro_lpf_hz` | `320` | `0` = off, else `10..1000` | Matches prior hardcoded α≈0.3345 at `dt=1/4000` (`α = dt/(τ+dt)`, `τ=1/(2π·fc)` → fc≈320 Hz) |
| `dterm_lpf_hz` | `53` | `0` = off, else `10..1000` | Matches prior D-term `τ=0.003` s (`fc=1/(2π·0.003)`≈53 Hz) |

Gyro LPF `dt` comes from the scheduler PID cadence (`pid_process_denom / gyro_hz`, default 2/8000 → 1/4000). D-term LPF uses the live `pid_set_dt` period (default `1/4000`). Schema5 persist/CLI migration is owned by Lead; this tree exposes RAM `get`/`set`/`defaults` keys only.

Host unit test: `bobflight_filter_test` / `scripts/test_flight_host_math.sh`.

## Mixer

QUADX motor index (DShot 0..3):

0. rear-right — `thr - roll + pitch - yaw`
1. front-right — `thr - roll - pitch + yaw`
2. rear-left — `thr + roll + pitch + yaw`
3. front-left — `thr + roll - pitch - yaw`

Each channel clamped to `[0,1]`.

## Arm rules

`arming_try_arm()` returns false unless **all** hold:

1. `gyro_is_healthy()` is true **and** cached gyro-ok flag is set
2. `failsafe_active()` is false
3. Throttle `rx_channels()[3] ≤ ARMING_THROTTLE_MAX` (`0.05`)

Boot state is **disarmed**. Unhealthy gyro while armed forces disarm.  
`failsafe_tick` on RX timeout calls `arming_disarm()`; the mixer/dshot loop then writes **zeros** (mid-air failsafe → motors off).

F7 V2 bf-derived bind has no gyro whoami yet → gyro stays unhealthy → arm still refuses (fail-closed).

## Dual-IR

Ship/treat as flight-ready when dual-IR unblocks. Host default dummy remains fail-closed; F7V2 is explicit bf-derived pins-only IR.
