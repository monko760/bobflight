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

OUT="$(printf 'set pid_roll_p 0.01\nget pid_roll_p\nset pid_yaw_d 0.0002\nget pid_yaw_d\nset pid_yaw_d 11\nset rate_max_yaw 600\nget rate_max_yaw\nset gyro_lpf_hz 400\nget gyro_lpf_hz\nset dterm_lpf_hz 100\nget dterm_lpf_hz\nset gyro_lpf_hz 5\nset dterm_lpf_hz 0\nget dterm_lpf_hz\nsave\ndefaults\nget pid_roll_p\nget pid_yaw_d\nget gyro_lpf_hz\nget dterm_lpf_hz\nget nope\n' | "$BIN")"
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

echo "PASS: CLI get/set/save/defaults (schema6 pid_yaw_d + LPF + rates/PID)"
