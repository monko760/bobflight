# Safety S1: gyro noise must not make the quad climb

Status: host-tested only. Not flown, not measured on hardware.
Scope: fly-away audit finding 1 plus the stale host CLI test expectation.
No new CLI keys, no new report lines, no settings renamed or migrated.

## The problem in one paragraph

High-frequency gyro noise (props, frame resonance, roughly 150-350 Hz)
passes through the PID, mostly through the D term, and becomes a fast
up-and-down wiggle on every motor command. The old mixer clipped each motor
on its own at `min_throttle` (default 0.05) and at 1.0. At low throttle the
bottom half of the wiggle was cut off and the top half was not, so the
*average* motor command went up. More noise meant more average thrust, so
the quad could climb on its own (a "fly-away"). On the 8000/2 profile the
soft gyro filter also ran only on every second gyro sample, so half the
samples reached nothing at all.

## What changed

1. **The gyro filter runs on every gyro sample.** The scheduler now calls
   `loop_filter()` after every gyro read, not only on PID cycles. The filter
   period is the gyro period (1 / gyro rate, e.g. 125 us at 8000/2) and it
   follows runtime loop-rate changes. The PID reads the newest filtered
   value. The notches run in the same place (after the low-pass), so their
   "below 0.45 x rate" check now uses the gyro rate.
2. **The mixer desaturates instead of clipping.** Exact rule (also in the
   comment in `src/flight/mixer.c`). `thr` is the stick throttle clamped to
   `[min_throttle, 1]`; `u[i]` is the PID part of motor i (the QUADX mix of
   roll, pitch and yaw; the four `u[i]` always add up to zero); `umin` /
   `umax` are the smallest / largest `u[i]`.
   1. If the spread does not fit (`umax - umin > 1 - min_throttle`), every
      `u[i]` is multiplied by `(1 - min_throttle) / (umax - umin)`.
   2. If the lowest motor would go below `min_throttle`
      (`thr + umin < min_throttle`), every `u[i]` is multiplied by
      `(thr - min_throttle) / -umin`. Throttle is **never** raised to make
      room, so clipping can no longer push the average above the stick.
      Only if the user has turned `airmode` on are the four motors shifted
      up by the shortfall instead (that is what airmode is for; it is off by
      default).
   3. If the highest motor would go above 1 (`thr + umax > 1`), all four
      motors are shifted down by the excess. The correction is kept in full;
      only the average drops below the stick.

   Steps 1 and 2 scale all three axes by the same factor, so the direction of
   the correction (roll : pitch : yaw) is kept and the four-motor average
   stays exactly at `thr`. After step 3 the average is below `thr`. With
   airmode off the average motor command is therefore never above the
   commanded throttle. The 5 % idle rule is unchanged: below 5 % stick with
   airmode off the PID is reset to zero, so the mixer has nothing to scale
   and nothing new happens there.

   **Warning: with airmode off there is NO roll/pitch/yaw correction at
   `min_throttle`.** At throttle = `min_throttle` no motor may go lower and
   the average may not go higher, so step 2 scales the correction to zero:
   all four motors sit at `min_throttle` and nothing corrects the attitude.
   Above it the correction can grow only as fast as the room below the
   motors: at throttle t the largest downward correction is
   t - `min_throttle`. b77b845 still corrected there through the motors that
   went up (and that is what made it climb on noise). If `min_throttle` is
   raised above 0.05 (allowed up to 0.2), stick between 5 % and
   `min_throttle` gets no correction at all: the PID runs, but nothing
   reaches the motors. QA repro: `min_throttle` 0.15, stick 0.10, constant
   disturbance: the quad drifts to -49 dps uncorrected (b77b845 held
   -21 dps, `airmode 1` holds -13 dps). There is no small code fix that keeps
   the no-climb rule: with every motor at or above `min_throttle` and the
   average at or below a throttle of `min_throttle`, every motor must equal
   `min_throttle`. **Fly tests with `airmode 1`, or keep `min_throttle` at
   the default 0.05.**
3. **I-term anti-windup on mixer saturation.** When step 1 or 2 had to scale
   the PID down, the mixer tells the PID (`pid_set_mixer_saturated`). On the
   next PID cycle no axis may grow its I accumulator in size; it may still
   shrink toward zero. The flag is cleared on every PID reset (disarm, idle).
   The freeze applies to all three axes whenever the mixer scaled, even if
   only one axis caused it (a yaw saturation also holds roll and pitch I).
   The existing freeze at the PID output limit (0.4) is unchanged.
4. **Second-order D-term filter on 8 kHz gyros.** When the gyro runs wide-band
   (8 kHz output, sensor DLPF 0: Kakute F7 HDV at `loop_rate_hz` 4000 or
   8000) the D-term low-pass becomes two identical first-order stages in a
   row. Each stage runs at `dterm_lpf_hz x 1.5538`, so the pair is still
   -3 dB at the configured `dterm_lpf_hz` (default 53 Hz). It stays on after
   a runtime fall-back to 1000/1, because the sensor DLPF stays 0. Boards and
   settings with the 1 kHz gyro output (sensor DLPF about 42 Hz) keep the
   first-order D filter exactly as before. `dterm_lpf_hz 0` still means off.
5. **Host CLI test expectation.** `scripts/test_host_cli.sh` and
   `scripts/test_dual_board_ci.sh` now expect `failsafe: ACTIVE`. The host
   build has no receiver, and failsafe is deliberately active from boot until
   the first valid RX frame (boot lockout, `failsafe_active()` in
   `failsafe.c`). **This changes only the test expectation, not firmware
   output:** the host `status` reply is byte-identical on b77b845 and on
   this branch for all three boards, and it already said `ACTIVE` before.

## Why the second-order D filter (item 4)

The noise reaches the motors mainly through D. With the defaults (gyro
low-pass 320 Hz, D low-pass 53 Hz first order, `pid_*_d` 0.00005) the gain
from gyro noise to PID output is:

| filter choice | D gain per dps at 183 / 197 / 291 / 305 Hz | extra lag at 20 Hz |
|---|---|---|
| b77b845: gyro 1st order 320 Hz, D 1st order 53 Hz | 0.0139 / 0.0137 / 0.0121 / 0.0119 | (reference) |
| **S1: D 2nd order 53 Hz (2 x 1st order at 82.4 Hz)** | **0.0084 / 0.0078 / 0.0050 / 0.0047** | **+6.6 deg on D only** |
| gyro 2nd order 320 Hz instead | 0.0141 / 0.0139 / 0.0122 / 0.0119 | +1.0 deg on the whole loop |
| gyro low-pass lowered to 150 Hz | 0.0101 / 0.0097 / 0.0075 / 0.0072 | +4.0 deg on the whole loop |
| D Butterworth biquad 53 Hz | 0.0042 / 0.0038 / 0.0022 / 0.0021 | +11 deg on D only |

For comparison the P path passes only 0.002 x 0.87 = 0.0017 per dps at
183 Hz, so D is about 8 times louder than P. The second-order D filter cuts
the D noise 1.7x at 183 Hz and 2.5x at 305 Hz. Making the gyro filter second
order does nothing at these frequencies (the noise is below 320 Hz), and
lowering the gyro cut-off only helps 1.4x while adding lag to P and I as
well, and it would need a "was this value the default?" guess that would not
respect a user who typed 320. The biquad is quieter still, but its
coefficients need a fixed period; the two-stage filter recomputes its
coefficient from the measured PID period every cycle like the old filter, so
a short first period after a rate change still cannot make a D spike (E4
below).

In the closed-loop host test the second-order D filter is what keeps the
correction usable once the mixer stops clipping: at 8000/2, throttle 0.20,
15 dps noise the mixer delivers on average 83 % of the requested correction
with it, against 55 % with the first-order filter (30 dps: 49 % vs 31 %).

## Before / after (host test `noise_saturation`)

Real scheduler, tasks, PID, mixer, DShot encoder and the real gyro filter
chain; sensor and DShot DMA mocked. Noise: roll A*sin(183 Hz) +
A/2*sin(291 Hz), pitch A*sin(197 Hz) + A/2*sin(305 Hz), yaw A/2*sin(211 Hz);
1 s per case, first 100 ms skipped. "Mean +" is the mean decoded motor
command minus the noiseless mean (0.0996 / 0.1996). "Hard clip" is the share
of cycles where the four motors are not "common level + s x PID mix" (shape
lost). Before = b77b845 sources with the same test (`-DNOISE_BASELINE`).

| rate | thr | A dps | mean + before | mean + after | hard clip before | after | mean cmd^2 before | after |
|---|---|---|---|---|---|---|---|---|
| 1000/1 | 0.10 | 15 | +0.058 | +0.0001 | 99 % | 0 % | 0.042 | 0.012 |
| 1000/1 | 0.10 | 30 | +0.133 | +0.0001 | 100 % | 0 % | 0.109 | 0.012 |
| 1000/1 | 0.20 | 15 | +0.026 | +0.0001 | 81 % | 0 % | 0.076 | 0.049 |
| 1000/1 | 0.20 | 30 | +0.092 | +0.0001 | 98 % | 0 % | 0.157 | 0.054 |
| 8000/2 | 0.10 | 15 | +0.077 | +0.0001 | 100 % | 0 % | 0.055 | 0.012 |
| 8000/2 | 0.10 | 30 | +0.153 | +0.0001 | 100 % | 0 % | 0.133 | 0.012 |
| 8000/2 | 0.20 | 15 | +0.041 | +0.0001 | 90 % | 0 % | 0.093 | 0.052 |
| 8000/2 | 0.20 | 30 | +0.110 | +0.0001 | 99 % | 0 % | 0.182 | 0.055 |
| 8000/1 | 0.10 | 15 | +0.082 | +0.0001 | 100 % | 0 % | 0.059 | 0.012 |
| 8000/1 | 0.10 | 30 | +0.157 | +0.0001 | 100 % | 0 % | 0.138 | 0.012 |
| 8000/1 | 0.20 | 15 | +0.045 | +0.0001 | 91 % | 0 % | 0.098 | 0.052 |
| 8000/1 | 0.20 | 30 | +0.114 | +0.0001 | 99 % | 0 % | 0.187 | 0.055 |

Noiseless mean cmd^2 is 0.0099 (thr 0.10) and 0.0398 (thr 0.20). On b77b845
at 8000/2 only 3601 of 7201 gyro samples were filtered; now all are. The
test asserts, for every row: the mean equals the rule (throttle minus the
step-3 shift, within 1.5 DShot steps), mean within 0.005 of noiseless at
throttle 0.10 / 0.20, hard clipping at most 0.5 %, time at a rail no more
than the old clamp would give on the same PID output, every gyro sample
filtered at 1 / gyro rate, still armed.
It also checks the I-term freeze (100 dps error the mixer cannot deliver at
throttle 0.10: I term 0.000015 after 300 ms; normal 2 dps error at 0.50:
0.0009) and that the shared chain applies a configured notch.

### High throttle (throttle 0.95, QA F2)

Noise now lowers the average motor command at full throttle more than
b77b845 did. Same test and noise, throttle 0.95 (noiseless mean 0.9496).
"Drop" is noiseless mean minus mean; "authority" is the share of the
requested correction the motors deliver (shape kept or not).

| rate, D filter | A dps | drop before | drop after | authority before | after |
|---|---|---|---|---|---|
| 8000/2, PT2 (Kakute default) | 15 | 0.077 | 0.125 | 61 %, shape lost | 100 % |
| 8000/2, PT2 (Kakute default) | 30 | 0.153 | 0.296 | 56 %, shape lost | 99 % |
| 8000/1, PT2 | 15 | 0.082 | 0.131 | 60 %, shape lost | 100 % |
| 8000/1, PT2 | 30 | 0.158 | 0.306 | 55 %, shape lost | 99 % |
| 1000/1, PT1 (tmotor, Kakute at 1000) | 15 | 0.058 | 0.190 | 63 %, shape lost | 100 % |
| 1000/1, PT1 (tmotor, Kakute at 1000) | 30 | 0.133 | 0.366 | 57 %, shape lost | 91 % |

Before = b77b845 (first-order D everywhere). Why, from the code: step 3
(`mixer.c`) shifts all four motors down by the largest excess over 1, so the
full correction is kept. b77b845 cut only the motors above 1, which lowered
the average by a quarter of each excess but also lost about 40 % of the
correction and its direction. The shift is the largest of the four excesses
and the old loss was their average, so the new drop is at most 4 x the old
loss on the same PID output (measured 3.2-3.6 x). A higher gyro rate passes
more 150-300 Hz noise into D (a 1 kHz loop's derivative and sampling damp
it), which is why 8000/x rows drop more than the old 1000/1 row; the
second-order D filter halves the drop at 8 kHz (8000/2, 15 dps: 0.125 with
it, 0.255 with first order). On a 1 kHz board the sensor's own 42 Hz DLPF
removes most of this noise before the firmware sees it, so the 1000/1 rows
overstate it there.

Acceptable for S1, in our view: it is never a climb, attitude control is kept
in full, and common flight-controller mixers make the same trade at the top
(keep the correction, lower the average). The cost is real: with heavy
high-frequency noise a full-throttle punch-out climbs less (Kakute default,
15 dps: average 0.83 instead of 0.95; 30 dps: 0.65). Treat it as a noise
problem showing up as lost thrust: check motor and frame noise before
high-throttle tests. The test bounds come from the rule, not from these
numbers: the mean is never above noiseless + 1 DShot step (no climb), it
equals throttle minus the step-3 shift within 1.5 steps, and the drop is at
most 4 x b77b845's top loss on the same PID output (+1 step).

No regression in the audit experiments: RX loss still disarms 251 ms after
the last frame at 1000/1, 8000/2, 8000/1 and with a mid-loss step to 1000/1
(E1). Stepping 8000/2 -> 1000/1 while armed (E4) shows no D spike: first D-
filter period 5 us, |D| peak 0.309 before / 0.295 after with the first-order
filter and 0.164 / 0.133 with the second-order filter (20 dps 200 Hz tone).

## Upgrade note: behaviour changes for existing saved configs

Saved settings are loaded and used as they are; nothing is renamed, added,
migrated or overwritten.

* **All boards, mixer:** where a correction used to be clipped, it is now
  scaled down (low throttle) or the throttle is lowered (near full
  throttle). No more throttle-dependent climb from noise.
* **All boards, airmode off: NO correction at `min_throttle`.** At
  throttle = `min_throttle` the motors give no roll/pitch/yaw correction at
  all, and above it the correction is limited to throttle - `min_throttle`.
  With `min_throttle` above 0.05, stick between 5 % and `min_throttle` is
  completely uncorrected (QA: `min_throttle` 0.15, stick 0.10 drifts to
  -49 dps). Fly tests with `airmode 1` or the default `min_throttle` 0.05.
* **All boards, full throttle with noise:** the average drops more than
  before (see "High throttle" above) while the correction is kept.
* **All boards, I term:** stops growing while the mixer is scaling the PID.
* **Airmode users (`airmode 1`):** at the low end the four motors are now
  shifted up together, which keeps the full correction; before, only the
  motors that needed to go up did. Airmode still raises average thrust at
  idle by design; noise can still lift the average there.
* **Kakute F7 HDV at `loop_rate_hz` 4000 (default) or 8000:** the D-term
  low-pass is second order at the same `dterm_lpf_hz`. A user-set
  `dterm_lpf_hz` is used as the -3 dB point; 0 still turns it off. D gets
  about 3 deg more lag at 10 Hz and 7 deg at 20 Hz. Re-check D tuning before
  flying. `loop_rate_hz` 1000 and the other boards are unchanged here.
* **Gyro filter rate:** the soft gyro low-pass and the notches now run at
  the gyro rate. On the default Kakute profile the read-only `filters` report
  shows `filters_sample_hz: 8000` instead of 4000 (same key, same order).
  The notch limit becomes 0.45 x 8000 = 3600 Hz; every allowed centre
  (20-1000 Hz) was already valid at 4000, so no notch changes state at the
  defaults. On the 4000/2 guard fall-back the limit rises from 900 to
  1800 Hz, so a saved notch between 900 and 1000 Hz that used to be
  reported `above-nyquist` there is now active. At 1000/1 nothing changes.
  The Configurator Filters-tab mock now mirrors 8000.
* **CPU:** at 8000/2 the gyro filter runs 8000 times a second instead of
  4000. Not measured on hardware; check `loop_overruns` after flashing.
* **RPM filter (#60):** its notches run inside the gyro filter, so they
  also run on every gyro sample. On the default Kakute profile the
  read-only `rpm_filter` report shows `rpm_filter_sample_hz: 8000` instead
  of 4000 (same key, same order; 1000/1 and the other boards unchanged), and
  the RPM filter's CPU cost doubles on the Kakute F7 at 8 kHz (estimate
  about 4.4-4.8 % of the CPU instead of 2.2-2.4 %; hardware unverified; the loop-rate guard,
  which falls back on overruns, is the safety net). The Configurator does
  no math: it shows the FC's value, and its mocks just carry the value the
  FC now reports (8000; `trimmed-1k` stays 1000).

## Tests

* `noise_saturation` (host, real cascade): tables above (throttle 0.10,
  0.20 and 0.95), `--table` prints them.
* `pid_s1_antiwindup_dterm` (host): I freeze and unwind rules, PT2 off by
  default, -3 dB at `dterm_lpf_hz`, 1.9x / 2.7x quieter at 200 / 300 Hz.
* `mixer_idle` (host): each desaturation step, mean never above throttle,
  shape kept, airmode shift-up only when enabled, saturation flag, and the
  top bound (motor 1.0) and spread threshold (`1 - min_throttle`) exactly
  at, just below and just above.
* `gyro_post_filter_chain` (host, real `gyro.c` chain, real scheduler and
  tasks): the RPM post-filter (#60) runs inside `gyro_filter()` after the
  low-pass and notches, once per gyro sample, at dt = 1 / gyro rate, and its
  output is the filtered gyro (8000/2, 8000/1, 1000/1). `gyro.c` gets a
  test-only switch, `BOBFLIGHT_HOST_GYRO_CHAIN`, that runs the target chain
  on the host for this test; other builds are unchanged.
* `loop_dt_follows_rate` (host): one filter update per gyro sample at
  1 / gyro rate; PID dt unchanged.
* `report_keys_contract` (host, real binary, every board): `status`,
  `filters`, `loop_rate` and `receiver` keep b77b845's keys in the same order
  (golden `tests/golden/report_keys_b77b845.json`). b77b845 has no
  `rpm_filter` command; its keys were captured from the #60 tip (04769f9,
  before S1) and are checked the same way.
* `report_bytes_contract` (host, real binary, every board): `status` is
  byte-identical to b77b845 (only the timing counters `cascade=`, `bg=` and
  `loop_overruns` may differ, and must stay plain integers); `filters` is
  byte-identical except `filters_sample_hz` on Kakute (4000 -> 8000). Golden
  `tests/golden/report_bytes_b77b845.json`. Catches value-format changes the
  key/order contract cannot see.
* `init_dterm_order` (host): the real `app_init()` turns the second D stage
  on for Kakute at 8 kHz ODR (`loop_rate_hz` 4000/8000) and off for
  tmotor_f7_v2 (1 kHz), Kakute at 1000, dummy and a failed rate write,
  deciding after the gyro rate select. Boot dependencies are stubbed; the
  gyro stub mirrors the driver's ODR bookkeeping.
* Configurator `ui/scripts/test-arm-gate-real-status.cjs`: real host `status`
  output (dummy, kakute_f7_hdv, tmotor_f7_v2) into the Configurator parser;
  Arm is blocked on `failsafe: ACTIVE`, on `gyro_ok: no`, and on both, and
  open only when both are clear. The dummy capture's `mmio: denied` with both
  gating lines clear must NOT block: mmio is display-only.

## Not verified

Flight behaviour, real motor/ESC thrust (the tables use decoded DShot
commands), MCU CPU time of the per-sample filter and of the RPM filter at
8 kHz, and the real MPU6000
reporting 8 kHz ODR on hardware (`init_dterm_order` covers init.c's decision
with a gyro stub; the host gyro itself reports no output rate).
