#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Host cascade: gyro inject → rates/pid/mixer (+ arm).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
cmake -S . -B build-host -DBOBFLIGHT_BOARD=dummy >/tmp/bf-cascade-cfg.log
cmake --build build-host --target bobflight_cascade_inject_test >/tmp/bf-cascade-build.log
./build-host/bobflight_cascade_inject_test
echo "PASS: cascade host inject test"
