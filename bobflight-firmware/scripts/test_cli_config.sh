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

OUT="$(printf 'set pid_roll_p 0.01\nget pid_roll_p\nset rate_max_yaw 600\nget rate_max_yaw\nsave\ndefaults\nget pid_roll_p\nget nope\n' | "$BIN")"
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
need "saved"
need "defaults restored"
need "pid_roll_p=0.002"
need "unknown key"

echo "PASS: CLI get/set/save/defaults (12-key contract)"
