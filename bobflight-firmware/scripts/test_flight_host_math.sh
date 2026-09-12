#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Host unit tests: flight math/arming + cascade inject + driver units.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cmake -S . -B build-host -DBOBFLIGHT_BOARD=dummy >/tmp/bf-host-cfg.log
cmake --build build-host --target \
  bobflight_rates_math_test \
  bobflight_arming_edges_test \
  bobflight_cascade_inject_test \
  bobflight_dshot_frame_test \
  bobflight_crsf_parse_test \
  bobflight_gyro_inject_test \
  >/tmp/bf-flight-tests-build.log
./build-host/bobflight_rates_math_test
./build-host/bobflight_arming_edges_test
./build-host/bobflight_cascade_inject_test
./build-host/bobflight_dshot_frame_test
./build-host/bobflight_crsf_parse_test
./build-host/bobflight_gyro_inject_test
echo "PASS: flight host math + cascade inject + driver host unit tests"
