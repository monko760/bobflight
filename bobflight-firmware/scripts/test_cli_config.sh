#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
#
# Host CLI get/set/save/defaults smoke for Configurator Rates/PID keys.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cmake -S . -B build-host -DBOBFLIGHT_BOARD=dummy >/tmp/bf-cli-cfg-cmake.log
cmake --build build-host --target bobflight_host >/tmp/bf-cli-cfg-build.log
BIN="$ROOT/build-host/bobflight_host"

OUT="$(printf 'get loop_rate_hz\nset loop_rate_hz 4000\nset loop_rate_hz 3000\nset loop_rate_hz 1000\nset pid_roll_p 0.01\nget pid_roll_p\nset pid_yaw_d 0.0002\nget pid_yaw_d\nset pid_yaw_d 11\nset rate_max_yaw 600\nget rate_max_yaw\nset gyro_lpf_hz 400\nget gyro_lpf_hz\nset dterm_lpf_hz 100\nget dterm_lpf_hz\nset gyro_lpf_hz 5\nset dterm_lpf_hz 0\nget dterm_lpf_hz\nsave\ndefaults\nget pid_roll_p\nget pid_yaw_d\nget gyro_lpf_hz\nget dterm_lpf_hz\nget nope\nget dshot_bidir\nget erpm_m1\nget erpm_m2\nget erpm_m3\nget erpm_m4\nget dshot_telem_m1\nget dshot_telem_m2\nget dshot_telem_m3\nget dshot_telem_m4\nset dshot_bidir on\nget dshot_bidir\nset dshot_bidir maybe\nset dshot_bidir off\nget dshot_bidir\nget erpm_m1\nget erpm_m4\nstatus\nloop_rate\nget gyro_notch1_hz\nset gyro_notch1_hz 200\nset gyro_notch1_cutoff_hz 150\nset gyro_notch1_hz 200\nget gyro_notch1_hz\nget gyro_notch1_cutoff_hz\nset gyro_notch2_cutoff_hz 400\nset gyro_notch2_hz 600\nget gyro_notch2_hz\nset gyro_notch1_cutoff_hz 250\nset gyro_notch1_hz 1200\nfilters\ndiff\nsave\ndefaults\nget gyro_notch1_hz\nget gyro_notch1_cutoff_hz\nfilters\n' | "$BIN")"
echo "$OUT"

need() {
  if ! grep -F -q -- "$1" <<<"$OUT"; then
    echo "FAIL: missing: $1" >&2
    exit 1
  fi
}

need "ok pid_roll_p=0.01"
need "pid_roll_p=0.01"
need "ok pid_yaw_d=0.0002"
need "pid_yaw_d=0.0002"
need "set failed"   # pid_yaw_d=11 out of range
need "ok rate_max_yaw=600"
need "rate_max_yaw=600"
need "ok gyro_lpf_hz=400"
need "gyro_lpf_hz=400"
need "ok dterm_lpf_hz=100"
need "dterm_lpf_hz=100"
need "set failed"   # gyro_lpf_hz=5 out of range
need "ok dterm_lpf_hz=0"
need "dterm_lpf_hz=0"
need "saved"
need "defaults restored"
need "pid_roll_p=0.002"
need "pid_yaw_d=5e-05"
need "gyro_lpf_hz=320"
need "dterm_lpf_hz=53"
need "unknown key"

# R0c DShot bidir / M1–M4 eRPM (RAM; default off → erpm none)
need "dshot_bidir=off"
need "erpm_m1=none"
need "erpm_m2=none"
need "erpm_m3=none"
need "erpm_m4=none"
need "none"           # get dshot_telem_mN default (status name only)
need "ok dshot_bidir=on"
need "dshot_bidir=on"
need "set failed"     # bad bidir token (also covers gyro_lpf / yaw_d OOR)
need "ok dshot_bidir=off"

# Frozen status loop-rate contract (Configurator): key: value, space after colon.
# Host dummy board keeps the deterministic 1000 Hz / denom 1 rate.
need "loop: gyro=1000 Hz denom=1"
need "loop_target_hz: 1000"
if ! grep -E -q $'^loop_actual_hz: (unavailable|0|[1-9][0-9]*)\r?$' <<<"$OUT"; then
  echo "FAIL: loop_actual_hz must be an integer or the literal unavailable" >&2
  exit 1
fi
if ! grep -E -q $'^loop_overruns: (0|[1-9][0-9]*)\r?$' <<<"$OUT"; then
  echo "FAIL: loop_overruns must be an unsigned integer" >&2
  exit 1
fi
need "loop_rate_profile: 1000/1"
need "loop_rate_hz=1000"
need "set failed: loop_rate_hz 4000 not supported on dummy (no 8 kHz gyro path)"
need "set failed: loop_rate_hz must be 1000, 4000 or 8000"
need "ok loop_rate_hz=1000"
need "note: loop_rate_hz takes effect after save + reboot"
need "loop_rate_reason: setting"
need "loop_rate_setting_hz: 1000"
need "loop_rate_pending_reboot: 0"
need "loop_rate_end: 1"

# Schema 8 manual gyro notches (dummy board runs 1000 Hz: 600 Hz is above Nyquist margin)
need "gyro_notch1_hz=0"
need "set failed: gyro_notch1_hz needs 0 < gyro_notch1_cutoff_hz < gyro_notch1_hz (set the cutoff first)"
need "ok gyro_notch1_cutoff_hz=150"
need "ok gyro_notch1_hz=200"
need "gyro_notch1_hz=200"
need "gyro_notch1_cutoff_hz=150"
need "ok gyro_notch2_cutoff_hz=400"
need "set failed: gyro_notch2_hz must be below 450 Hz at the running 1000 Hz loop rate"
need "gyro_notch2_hz=0"
need "set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz"
need "set failed: gyro_notch1_hz must be 0 or 20..1000"
need "filters_api: 1"
need "filters_sample_hz: 1000"
need "gyro_notch1_active: yes"
need "gyro_notch1_reason: ok"
need "gyro_notch2_active: no"
need "gyro_notch2_reason: off"
need "filters_end: 1"
need "set gyro_notch1_cutoff_hz 150"
need "set gyro_notch1_hz 200"
need "set gyro_notch2_cutoff_hz 400"
need "# schema: 8"
need "gyro_notch1_reason: off"

echo "PASS: CLI get/set/save/defaults (schema8 gyro notches + schema7 loop_rate_hz + schema6 pid_yaw_d + LPF + rates/PID + dshot R0c M1-M4) + status loop_target/actual/overruns"
