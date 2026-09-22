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

OUT="$(printf 'set pid_roll_p 0.01\nget pid_roll_p\nset rate_max_yaw 600\nget rate_max_yaw\nset gyro_lpf_hz 400\nget gyro_lpf_hz\nset dterm_lpf_hz 100\nget dterm_lpf_hz\nset gyro_lpf_hz 5\nset dterm_lpf_hz 0\nget dterm_lpf_hz\nsave\ndefaults\nget pid_roll_p\nget gyro_lpf_hz\nget dterm_lpf_hz\nget nope\nget dshot_bidir\nget erpm_m1\nget erpm_m2\nget erpm_m3\nget erpm_m4\nget dshot_telem_m1\nget dshot_telem_m2\nget dshot_telem_m3\nget dshot_telem_m4\nset dshot_bidir on\nget dshot_bidir\nset dshot_bidir maybe\nset dshot_bidir off\nget dshot_bidir\nget erpm_m1\nget erpm_m4\n' | "$BIN")"
echo "$OUT"

need() {
  if ! grep -F -q -- "$1" <<<"$OUT"; then
    echo "FAIL: missing: $1" >&2
    exit 1
  fi
}

need "ok pid_roll_p=0.01"
need "pid_roll_p=0.01"
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
need "set failed"     # bad bidir token (also covers gyro_lpf out-of-range)
need "ok dshot_bidir=off"

echo "PASS: CLI get/set/save/defaults (schema5 LPF + rates/PID + dshot R0c M1-M4)"
