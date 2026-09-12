#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Host unit tests for Drivers: DShot frame, CRSF parse, gyro inject.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cmake -S . -B build-host >/tmp/bf-host-cfg.log
cmake --build build-host --target \
  bobflight_dshot_frame_test \
  bobflight_crsf_parse_test \
  bobflight_gyro_inject_test \
  >/tmp/bf-drivers-host-build.log
./build-host/bobflight_dshot_frame_test
./build-host/bobflight_crsf_parse_test
./build-host/bobflight_gyro_inject_test
echo "PASS: drivers host unit tests (DShot / CRSF / gyro inject)"
