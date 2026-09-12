#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
#
# Host CLI/status smoke — default contract is dummy IR.
# Multi-board matrix (dummy + tmotor_f7_v2 + kakute_f7_hdv): scripts/test_dual_board_ci.sh
#
# Board select (CMake switch LANDED):
#   env BOBFLIGHT_BOARD / BOARD = dummy | tmotor_f7_v2 | kakute_f7_hdv
#   CMake -DBOBFLIGHT_BOARD=dummy|tmotor_f7_v2|kakute_f7_hdv (default dummy)
# Script detects the switch and passes -DBOBFLIGHT_BOARD=${BOARD_SEL}.
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BOARD_SEL="${BOBFLIGHT_BOARD:-${BOARD:-}}"
if [[ -z "$BOARD_SEL" ]]; then
  BOARD_SEL="dummy"
fi

case "$BOARD_SEL" in
  dummy|tmotor_f7_v2|kakute_f7_hdv) ;;
  *)
    echo "FAIL: unsupported board '$BOARD_SEL' (dummy|tmotor_f7_v2|kakute_f7_hdv)" >&2
    echo "  Dual matrix: ./scripts/test_dual_board_ci.sh" >&2
    exit 1
    ;;
esac

# No GPL Betaflight config.h / trees (owned src/flight/config.h is OK)
if find . \( -path '*betaflight*' -o -name 'config.h' \) | grep -v '/build-' | grep -v 'src/flight/config.h' | grep -q .; then
  echo "FAIL: BF / config.h leaked into firmware tree" >&2
  find . \( -path '*betaflight*' -o -name 'config.h' \) | grep -v '/build-' | grep -v 'src/flight/config.h' >&2 || true
  exit 1
fi

# If CMake exposes BOBFLIGHT_BOARD, pass it; otherwise build uses checked-in pins_generated.h.
CMAKE_EXTRA=()
if rg -n --glob '!build-*' \
    -e 'option\s*\(\s*BOBFLIGHT_BOARD\b' \
    -e 'set\s*\(\s*BOBFLIGHT_BOARD\b' \
    -e 'BOBFLIGHT_BOARD\s+CACHE' \
    "$ROOT/CMakeLists.txt" "$ROOT/cmake" 2>/dev/null | grep -q .; then
  CMAKE_EXTRA+=("-DBOBFLIGHT_BOARD=${BOARD_SEL}")
elif [[ -n "${BOBFLIGHT_BOARD:-${BOARD:-}}" ]]; then
  echo "NOTE: BOBFLIGHT_BOARD/BOARD=$BOARD_SEL set but CMake switch absent;"
  echo "      assertions will use that contract against current pins_generated.h."
  echo "      Prefer ./scripts/test_dual_board_ci.sh (codegen + matrix)."
fi

cmake -S . -B build-host "${CMAKE_EXTRA[@]}" >/tmp/bf-host-cfg.log
cmake --build build-host >/tmp/bf-host-build.log
BIN="$ROOT/build-host/bobflight_host"

OUT="$(printf 'help\nstatus\narm\ndisarm\nnope\n' | "$BIN")"
echo "$OUT"

need() {
  if ! grep -F -q -- "$1" <<<"$OUT"; then
    echo "FAIL: missing: $1" >&2
    echo "HINT: dual-board matrix is scripts/test_dual_board_ci.sh" >&2
    exit 1
  fi
}

need "BobFlight CLI"
need "gyro_ok: no"
need "arm: disarmed"
need "failsafe: ok"
need "arm refused (gyro unhealthy or failsafe)"
need "disarmed"
need "unknown — try help"
need "bobflight host smoke: ok (cascade exercised)"

if [[ "$BOARD_SEL" == "dummy" ]]; then
  need "board: dummy"
  need "ir: dummy"
  need "gyro_bind: dummy"
  need "dshot_bound: 0/4"
  need "rx: CRSF unbound"
  need "mmio: denied"
elif [[ "$BOARD_SEL" == "tmotor_f7_v2" ]]; then
  need "board: tmotor_f7_v2"
  need "ir: bf-derived"
  need "gyro_bind: bf-derived"
  need "dshot_bound: 4/4"
  need "rx: CRSF bound"
  need "mmio: allowed (bf-derived)"
elif [[ "$BOARD_SEL" == "kakute_f7_hdv" ]]; then
  need "board: kakute_f7_hdv"
  need "ir: bf-derived"
  need "gyro_bind: bf-derived"
  need "dshot_bound: 4/4"
  need "rx: CRSF bound"
  need "mmio: allowed (bf-derived)"
else
  echo "FAIL: no assertions for board '$BOARD_SEL'" >&2
  exit 1
fi

if grep -Eiq "betaflight" <<<"$OUT"; then
  echo "FAIL: BF string leak in CLI" >&2
  exit 1
fi
if grep -E -q "P[A-Z][0-9]" <<<"$OUT"; then
  echo "FAIL: pin name leak in CLI" >&2
  exit 1
fi

echo "PASS: host CLI/status ($BOARD_SEL)"
echo "NOTE: full dual-board CI → ./scripts/test_dual_board_ci.sh"
