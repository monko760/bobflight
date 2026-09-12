#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
#
# Dual-board CI matrix: dummy + tmotor_f7_v2 + kakute_f7_hdv
#
# Board selection (prefer in this order):
#   1. CMake CACHE BOBFLIGHT_BOARD (LANDED) — cmake -DBOBFLIGHT_BOARD=<id>
#   2. Env BOBFLIGHT_BOARD / BOARD for a single-cell override
#   3. Prep fallback only if CMake switch absent: ir_codegen.py → pins_generated.h
#
# Interface:
#   -DBOBFLIGHT_BOARD=dummy|tmotor_f7_v2|kakute_f7_hdv
#   equivalent env BOBFLIGHT_BOARD=… honored by CMake or this script
#
# Usage:
#   ./scripts/test_dual_board_ci.sh           # full matrix
#   BOARD=dummy ./scripts/test_dual_board_ci.sh   # single cell
#   REQUIRE_CMAKE_BOARD=1 ./scripts/test_dual_board_ci.sh  # exit 2 until switch exists
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PINS_H="$ROOT/src/board/pins_generated.h"
PINS_BAK=""
CODEGEN="$ROOT/scripts/ir_codegen.py"
OVERALL=0
CMAKE_BOARD_SWITCH=0
SELECTION_MODE="codegen"

IR_DUMMY="$ROOT/boards/dummy.yaml"
IR_V2="$ROOT/boards/tmotor-ir/tmotor_f7_v2.yaml"
if [[ ! -f "$IR_V2" ]]; then
  IR_V2="/workspace/board-defs/tmotor/tmotor_f7_v2.yaml"
fi
IR_KAKUTE="$ROOT/boards/holybro-ir/kakute_f7_hdv.yaml"
if [[ ! -f "$IR_KAKUTE" ]]; then
  IR_KAKUTE="/workspace/board-defs/holybro/kakute_f7_hdv.yaml"
fi

die() { echo "FAIL: $*" >&2; exit 1; }

detect_cmake_board_switch() {
  # True only for a real board-select API — not BOBFLIGHT_BOARD_H include guards.
  if rg -n --glob '!build-*' \
      -e 'option\s*\(\s*BOBFLIGHT_BOARD\b' \
      -e 'set\s*\(\s*BOBFLIGHT_BOARD\b' \
      -e 'CACHE\s+STRING\s+".*BOBFLIGHT_BOARD' \
      -e 'BOBFLIGHT_BOARD\s+CACHE' \
      "$ROOT/CMakeLists.txt" "$ROOT/cmake" 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

ir_for_board() {
  case "$1" in
    dummy) echo "$IR_DUMMY" ;;
    tmotor_f7_v2) echo "$IR_V2" ;;
    kakute_f7_hdv) echo "$IR_KAKUTE" ;;
    *) die "unknown board id: $1 (expected dummy|tmotor_f7_v2|kakute_f7_hdv)" ;;
  esac
}

save_pins() {
  if [[ -f "$PINS_H" ]]; then
    PINS_BAK="$(mktemp "$ROOT/src/board/pins_generated.h.bak.XXXXXX")"
    cp -a "$PINS_H" "$PINS_BAK"
  fi
}

restore_pins() {
  if [[ -n "$PINS_BAK" && -f "$PINS_BAK" ]]; then
    mv -f "$PINS_BAK" "$PINS_H"
    PINS_BAK=""
  fi
}

cleanup() { restore_pins; }
trap cleanup EXIT

need_in() {
  local haystack="$1" needle="$2"
  if ! grep -F -q -- "$needle" <<<"$haystack"; then
    echo "  missing assertion: $needle" >&2
    return 1
  fi
  return 0
}

assert_host_cli() {
  local board="$1" out="$2" ok=0
  need_in "$out" "BobFlight CLI" || ok=1
  need_in "$out" "arm: disarmed" || ok=1
  need_in "$out" "failsafe: ok" || ok=1
  need_in "$out" "arm refused (gyro unhealthy or failsafe)" || ok=1
  need_in "$out" "disarmed" || ok=1
  need_in "$out" "unknown — try help" || ok=1
  need_in "$out" "bobflight host smoke: ok (cascade exercised)" || ok=1
  if grep -Eiq "betaflight" <<<"$out"; then
    echo "  FAIL: BF string leak in CLI" >&2
    ok=1
  fi
  if grep -E -q "P[A-Z][0-9]" <<<"$out"; then
    echo "  FAIL: pin name leak in CLI" >&2
    ok=1
  fi

  case "$board" in
    dummy)
      need_in "$out" "board: dummy" || ok=1
      need_in "$out" "ir: dummy" || ok=1
      need_in "$out" "gyro_ok: no" || ok=1
      need_in "$out" "gyro_bind: dummy" || ok=1
      need_in "$out" "dshot_bound: 0/4" || ok=1
      need_in "$out" "rx: CRSF unbound" || ok=1
      need_in "$out" "mmio: denied" || ok=1
      ;;
    tmotor_f7_v2)
      need_in "$out" "board: tmotor_f7_v2" || ok=1
      need_in "$out" "ir: bf-derived" || ok=1
      need_in "$out" "gyro_ok: no" || ok=1
      need_in "$out" "gyro_bind: bf-derived" || ok=1
      need_in "$out" "dshot_bound: 4/4" || ok=1
      need_in "$out" "rx: CRSF bound" || ok=1
      need_in "$out" "mmio: allowed (bf-derived)" || ok=1
      ;;
    kakute_f7_hdv)
      need_in "$out" "board: kakute_f7_hdv" || ok=1
      need_in "$out" "ir: bf-derived" || ok=1
      need_in "$out" "gyro_ok: no" || ok=1
      need_in "$out" "gyro_bind: bf-derived" || ok=1
      need_in "$out" "dshot_bound: 4/4" || ok=1
      need_in "$out" "rx: CRSF bound" || ok=1
      need_in "$out" "mmio: allowed (bf-derived)" || ok=1
      ;;
  esac
  return "$ok"
}

select_board_for_build() {
  local board="$1"
  local ir
  ir="$(ir_for_board "$board")"
  [[ -f "$ir" ]] || die "IR not found for $board: $ir"

  CMAKE_EXTRA=()
  if [[ "$CMAKE_BOARD_SWITCH" -eq 1 ]]; then
    SELECTION_MODE="cmake-BOBFLIGHT_BOARD"
    CMAKE_EXTRA+=("-DBOBFLIGHT_BOARD=${board}")
    echo "  select: -DBOBFLIGHT_BOARD=${board}"
  else
    SELECTION_MODE="ir_codegen (BOBFLIGHT_BOARD CMake switch absent)"
    echo "  select: ir_codegen ← $ir"
    python3 "$CODEGEN" "$ir" -o "$PINS_H"
  fi
}

run_host_cell() {
  local board="$1"
  local build_dir="$ROOT/build-host-ci-${board}"
  local bin out rc=0

  echo ""
  echo "==== CELL host/$board ===="
  select_board_for_build "$board"

  if ! cmake -S . -B "$build_dir" "${CMAKE_EXTRA[@]}" >/tmp/bf-ci-host-${board}-cfg.log 2>&1; then
    echo "FAIL host/$board configure (see /tmp/bf-ci-host-${board}-cfg.log)"
    return 1
  fi
  if ! cmake --build "$build_dir" >/tmp/bf-ci-host-${board}-build.log 2>&1; then
    echo "FAIL host/$board build (see /tmp/bf-ci-host-${board}-build.log)"
    return 1
  fi
  bin="$build_dir/bobflight_host"
  [[ -x "$bin" ]] || die "missing $bin"

  out="$(printf 'help\nstatus\narm\ndisarm\nnope\n' | "$bin" || true)"
  if assert_host_cli "$board" "$out"; then
    echo "PASS host/$board CLI smoke"
    return 0
  fi
  echo "---- CLI output ----"
  echo "$out"
  echo "FAIL host/$board CLI assertions"
  return 1
}

mcu_toolchain_for_board() {
  case "$1" in
    kakute_f7_hdv) echo "cmake/stm32f745.cmake" ;;
    *) echo "cmake/stm32f722.cmake" ;;
  esac
}

mcu_tag_for_board() {
  case "$1" in
    kakute_f7_hdv) echo "f745" ;;
    *) echo "f722" ;;
  esac
}

run_mcu_cell() {
  local board="$1"
  local tag toolchain build_dir
  tag="$(mcu_tag_for_board "$board")"
  toolchain="$(mcu_toolchain_for_board "$board")"
  build_dir="$ROOT/build-${tag}-ci-${board}"

  echo ""
  echo "==== CELL ${tag}/$board ===="
  if ! command -v arm-none-eabi-gcc >/dev/null 2>&1; then
    echo "FAIL ${tag}/$board: arm-none-eabi-gcc not on PATH"
    return 1
  fi
  select_board_for_build "$board"

  if ! cmake -S . -B "$build_dir" \
      -DCMAKE_TOOLCHAIN_FILE="$toolchain" \
      -DBOBFLIGHT_HOST_SMOKE=OFF \
      "${CMAKE_EXTRA[@]}" >/tmp/bf-ci-${tag}-${board}-cfg.log 2>&1; then
    echo "FAIL ${tag}/$board configure (see /tmp/bf-ci-${tag}-${board}-cfg.log)"
    return 1
  fi
  if ! cmake --build "$build_dir" >/tmp/bf-ci-${tag}-${board}-build.log 2>&1; then
    echo "FAIL ${tag}/$board build (see /tmp/bf-ci-${tag}-${board}-build.log)"
    return 1
  fi
  if [[ ! -f "$build_dir/bobflight.elf" ]]; then
    echo "FAIL ${tag}/$board: bobflight.elf missing"
    return 1
  fi
  if [[ ! -f "$build_dir/bobflight.hex" ]]; then
    echo "FAIL ${tag}/$board: bobflight.hex missing"
    return 1
  fi
  echo "PASS ${tag}/$board configure+build"
  return 0
}

# --- preamble ---
echo "BobFlight dual-board CI matrix"
echo "ROOT=$ROOT"

if detect_cmake_board_switch; then
  CMAKE_BOARD_SWITCH=1
  echo "BOBFLIGHT_BOARD: FOUND (CMake)"
else
  CMAKE_BOARD_SWITCH=0
  echo "BOBFLIGHT_BOARD: NOT FOUND in CMake (gated)"
  echo "  Required (FW Lead): option/set CACHE BOBFLIGHT_BOARD=dummy|tmotor_f7_v2|kakute_f7_hdv"
  echo "  Prep path active: BOARD= / matrix uses scripts/ir_codegen.py → pins_generated.h"
fi

if [[ "${REQUIRE_CMAKE_BOARD:-0}" == "1" && "$CMAKE_BOARD_SWITCH" -eq 0 ]]; then
  echo "BLOCKED: REQUIRE_CMAKE_BOARD=1 and CMake BOBFLIGHT_BOARD is absent" >&2
  exit 2
fi

[[ -f "$IR_DUMMY" ]] || die "missing $IR_DUMMY"
[[ -f "$IR_V2" ]] || die "missing tmotor_f7_v2 IR ($IR_V2)"
[[ -f "$IR_KAKUTE" ]] || die "missing kakute_f7_hdv IR ($IR_KAKUTE)"
[[ -x "$CODEGEN" || -f "$CODEGEN" ]] || die "missing $CODEGEN"

save_pins

BOARDS=(dummy tmotor_f7_v2 kakute_f7_hdv)
if [[ -n "${BOARD:-${BOBFLIGHT_BOARD:-}}" ]]; then
  BOARDS=("${BOARD:-$BOBFLIGHT_BOARD}")
fi

declare -a RESULTS=()
for b in "${BOARDS[@]}"; do
  if run_host_cell "$b"; then
    RESULTS+=("PASS host/$b")
  else
    RESULTS+=("FAIL host/$b")
    OVERALL=1
  fi
done

# MCU build: F722 for tmotor_f7_v2, F745 for kakute_f7_hdv
for b in "${BOARDS[@]}"; do
  if [[ "$b" == "tmotor_f7_v2" || "$b" == "kakute_f7_hdv" ]]; then
    tag="$(mcu_tag_for_board "$b")"
    if run_mcu_cell "$b"; then
      RESULTS+=("PASS ${tag}/$b")
    else
      RESULTS+=("FAIL ${tag}/$b")
      OVERALL=1
    fi
  fi
done


# Host driver unit tests (DShot/CRSF/gyro inject) — board-independent
echo ""
echo "==== HOST driver unit tests ===="
if "$ROOT/scripts/test_drivers_host.sh"; then
  RESULTS+=("PASS host/drivers_unit")
else
  RESULTS+=("FAIL host/drivers_unit")
  OVERALL=1
fi

echo ""
echo "==== HOST cascade inject (Flight) ===="
if "$ROOT/scripts/test_cascade_host.sh"; then
  RESULTS+=("PASS host/cascade_inject")
else
  RESULTS+=("FAIL host/cascade_inject")
  OVERALL=1
fi

echo ""
echo "==== MATRIX SUMMARY ===="
echo "selection_mode=$SELECTION_MODE"
echo "cmake_BOBFLIGHT_BOARD=$CMAKE_BOARD_SWITCH"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done

if [[ "$OVERALL" -ne 0 ]]; then
  echo "OVERALL: FAIL"
  exit 1
fi
echo "OVERALL: PASS"
exit 0
