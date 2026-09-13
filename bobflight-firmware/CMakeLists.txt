# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
#
# BobFlight clean-room firmware skeleton.
# Host smoke (default): gcc, no MCU.
# Cross: cmake -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake ...
# Board: -DBOBFLIGHT_BOARD=dummy|tmotor_f7_v2|kakute_f7_hdv (default dummy)
# Kakute MCU: -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake -DBOBFLIGHT_BOARD=kakute_f7_hdv

cmake_minimum_required(VERSION 3.16)
project(bobflight C)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
enable_testing()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra)

# --- Formal board IR select (default: dummy / fail-closed) ---
set(BOBFLIGHT_BOARD "dummy" CACHE STRING "Board IR id: dummy | tmotor_f7_v2 | kakute_f7_hdv")
set_property(CACHE BOBFLIGHT_BOARD PROPERTY STRINGS dummy tmotor_f7_v2 kakute_f7_hdv)
if(NOT BOBFLIGHT_BOARD STREQUAL "dummy"
   AND NOT BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2"
   AND NOT BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv")
  message(FATAL_ERROR "BOBFLIGHT_BOARD must be dummy|tmotor_f7_v2|kakute_f7_hdv (got '${BOBFLIGHT_BOARD}')")
endif()

if(BOBFLIGHT_BOARD STREQUAL "dummy")
  set(BOBFLIGHT_IR_YAML "${CMAKE_SOURCE_DIR}/boards/dummy.yaml")
elseif(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2")
  set(_bf_ir_local "${CMAKE_SOURCE_DIR}/boards/tmotor-ir/tmotor_f7_v2.yaml")
  if(EXISTS "${_bf_ir_local}")
    set(BOBFLIGHT_IR_YAML "${_bf_ir_local}")
  else()
    set(BOBFLIGHT_IR_YAML "/workspace/board-defs/tmotor/tmotor_f7_v2.yaml")
  endif()
elseif(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv")
  set(_bf_ir_local "${CMAKE_SOURCE_DIR}/boards/holybro-ir/kakute_f7_hdv.yaml")
  if(EXISTS "${_bf_ir_local}")
    set(BOBFLIGHT_IR_YAML "${_bf_ir_local}")
  else()
    set(BOBFLIGHT_IR_YAML "/workspace/board-defs/holybro/kakute_f7_hdv.yaml")
  endif()
endif()

if(NOT EXISTS "${BOBFLIGHT_IR_YAML}")
  message(FATAL_ERROR "BobFlight IR YAML missing for ${BOBFLIGHT_BOARD}: ${BOBFLIGHT_IR_YAML}")
endif()

# Configure-time codegen into the build tree (never overwrites checked-in src/board/pins_generated.h).
set(BOBFLIGHT_PINS_GEN "${CMAKE_BINARY_DIR}/generated/board/pins_generated.h")
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/generated/board")
execute_process(
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/ir_codegen.py"
          "${BOBFLIGHT_IR_YAML}" -o "${BOBFLIGHT_PINS_GEN}"
  RESULT_VARIABLE _bf_cg_rc
  OUTPUT_VARIABLE _bf_cg_out
  ERROR_VARIABLE _bf_cg_err)
if(NOT _bf_cg_rc EQUAL 0)
  message(FATAL_ERROR "ir_codegen.py failed for ${BOBFLIGHT_BOARD}: ${_bf_cg_out} ${_bf_cg_err}")
endif()
message(STATUS "BobFlight: BOBFLIGHT_BOARD=${BOBFLIGHT_BOARD} IR=${BOBFLIGHT_IR_YAML}")
# Kakute is STM32F745 — motors 5–6 deferred (BOARD_MOTOR_MAX/DSHOT=4 packs first 4 only).
if(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv" AND NOT DEFINED BOBFLIGHT_TARGET_MCU)
  # Host builds leave MCU unset; cross builds should use cmake/stm32f745.cmake.
endif()

# Rebuild pins if IR YAML or codegen script changes.
add_custom_command(
  OUTPUT "${BOBFLIGHT_PINS_GEN}"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_BINARY_DIR}/generated/board"
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/ir_codegen.py"
          "${BOBFLIGHT_IR_YAML}" -o "${BOBFLIGHT_PINS_GEN}"
  DEPENDS "${BOBFLIGHT_IR_YAML}" "${CMAKE_SOURCE_DIR}/scripts/ir_codegen.py"
  COMMENT "BobFlight IR codegen → ${BOBFLIGHT_PINS_GEN}"
  VERBATIM)
add_custom_target(bobflight_pins_gen DEPENDS "${BOBFLIGHT_PINS_GEN}")

option(BOBFLIGHT_HOST_SMOKE "Build host smoke binary (no MCU)" ON)
option(BOBFLIGHT_FLIGHT_ENABLE "Enable AUX1 flight arming after physical bench validation" OFF)
option(BOBFLIGHT_ACCEL_BENCH_RELAXED "Experimental relaxed accel pose checks; never flight-qualified" OFF)
if(BOBFLIGHT_ACCEL_BENCH_RELAXED AND BOBFLIGHT_FLIGHT_ENABLE)
  message(FATAL_ERROR "Relaxed accelerometer calibration is bench-only: flight must remain disabled")
endif()
# TMOTORF7V2 is initially a USB/sensor comparison target, never a flight image.
if(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2")
  if(BOBFLIGHT_FLIGHT_ENABLE OR BOBFLIGHT_ACCEL_BENCH_RELAXED)
    message(FATAL_ERROR "TMOTORF7V2 sensor bring-up requires flight and relaxed calibration OFF")
  endif()
  if(DEFINED BOBFLIGHT_TARGET_MCU AND NOT BOBFLIGHT_TARGET_MCU STREQUAL "STM32F722")
    message(FATAL_ERROR "TMOTORF7V2 requires the STM32F722 toolchain, not F745/H7")
  endif()
  add_compile_definitions(BOBFLIGHT_TARGET_TMOTORF7V2=1 BOBFLIGHT_TARGET_MCU_STM32F722=1)
endif()
option(BOBFLIGHT_PROVE_RESET "Reset_Handler-only forever PA2 blink (never main); diagnostic" OFF)
option(BOBFLIGHT_BOOT_LED_DIAGNOSTICS "Blocking startup LED patterns for bring-up; leave OFF for normal boots" OFF)
add_compile_definitions(BOBFLIGHT_BOOT_LED_DIAGNOSTICS=$<BOOL:${BOBFLIGHT_BOOT_LED_DIAGNOSTICS}>)

# API detection permits the independently developed four-row mode interface without
# silently omitting ACRO/HORIZON or AUX/manual selection. On-disk row count is validated.
file(STRINGS "${CMAKE_SOURCE_DIR}/src/sched/tasks.h" BF_CONTROL_SOURCE_DECL REGEX "bool control_source_set")
if(BF_CONTROL_SOURCE_DECL)
  add_compile_definitions(BOBFLIGHT_CONTROL_SOURCE_API=1)
endif()

set(BF_COMMON_SOURCES
  src/app/main.c
  src/app/init.c
  src/sched/scheduler.c
  src/sched/tasks.c
  src/flight/pid.c
  src/flight/attitude.c
  src/flight/mixer.c
  src/flight/arming.c
  src/flight/failsafe.c
  src/flight/rates.c
  src/flight/horizon.c
  src/flight/config.c
  src/flight/mode_range.c
  src/drivers/gyro.c src/drivers/sensor_calibration.c
  src/drivers/dshot.c
  src/drivers/rx.c
  src/drivers/crsf.c
  src/drivers/cli.c
  src/drivers/persist.c
  src/drivers/config_store.c
  src/drivers/power.c
  src/board/ir_load.c
)

# Build-tree generated/ must win over checked-in src/board/pins_generated.h (dummy fallback).
include_directories(
  ${CMAKE_BINARY_DIR}/generated
  ${CMAKE_SOURCE_DIR}/include
  ${CMAKE_SOURCE_DIR}/src
)

if(BOBFLIGHT_HOST_SMOKE AND NOT CMAKE_CROSSCOMPILING)
  add_executable(bobflight_config_store_test tests/host_config_store.c)
  add_executable(bobflight_flash_watchdog_test tests/host_flash_watchdog.c)
  target_include_directories(bobflight_flash_watchdog_test PRIVATE src)
  add_test(NAME flash_watchdog COMMAND bobflight_flash_watchdog_test)
  add_test(NAME config_store COMMAND bobflight_config_store_test)
  add_test(NAME tmotor_image_validator COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_tmotor_image.py ${CMAKE_SOURCE_DIR})
  add_executable(bobflight_tmotor_peripherals_test tests/host_tmotor_peripherals.c
    src/hal/stm32f7/hal_tim_dma.c src/hal/stm32f7/hal_adc.c src/hal/stm32f7/hal_flash.c)
  target_compile_options(bobflight_tmotor_peripherals_test PRIVATE -include ${CMAKE_SOURCE_DIR}/tests/tmotor_peripheral_mocks.h)
  add_test(NAME tmotor_peripherals_fail_closed COMMAND bobflight_tmotor_peripherals_test)
  add_executable(bobflight_bootloader_policy_test tests/host_bootloader_policy.c)
  add_test(NAME bootloader_reset_policy COMMAND bobflight_bootloader_policy_test)
  add_executable(bobflight_bootloader_cli_test tests/host_bootloader_cli.c)
  add_test(NAME bootloader_cli_safety COMMAND bobflight_bootloader_cli_test)
  add_executable(bobflight_gyro_spi_map_test tests/host_gyro_spi_map.c)
  add_test(NAME gyro_spi_map COMMAND bobflight_gyro_spi_map_test)
  add_test(NAME tmotor_target_contract COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_tmotor_target.py ${CMAKE_SOURCE_DIR} ${CMAKE_C_COMPILER})
  add_executable(bobflight_persist_config_test tests/host_persist_config.c src/flight/config.c src/flight/mode_range.c src/drivers/sensor_calibration.c)
  target_link_libraries(bobflight_persist_config_test m)
  add_test(NAME persist_config COMMAND bobflight_persist_config_test)
  add_executable(bobflight_storage_cli_test src/flight/config.c tests/host_storage_cli.c)
  target_link_libraries(bobflight_storage_cli_test m)
  add_test(NAME storage_cli COMMAND bobflight_storage_cli_test)
  add_executable(bobflight_mode_range_test src/flight/mode_range.c tests/host_mode_range.c)
  target_link_libraries(bobflight_mode_range_test m)
  add_test(NAME mode_range COMMAND bobflight_mode_range_test)
  add_executable(bobflight_pid_elapsed_test src/sched/tasks.c src/flight/attitude.c tests/host_pid_elapsed.c)
  target_sources(bobflight_pid_elapsed_test PRIVATE src/flight/rates.c src/flight/config.c)
  target_sources(bobflight_pid_elapsed_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_pid_elapsed_test m)
  add_test(NAME pid_elapsed COMMAND bobflight_pid_elapsed_test)
  add_executable(bobflight_cycle_clock_test tests/host_cycle_clock.c)
  add_test(NAME cycle_clock COMMAND bobflight_cycle_clock_test)
  add_executable(bobflight_f7_clock_test src/hal/stm32f7/hal_clock.c tests/host_f7_clock.c)
  target_compile_options(bobflight_f7_clock_test PRIVATE -include ${CMAKE_SOURCE_DIR}/tests/clock_hw_mock.h)
  add_test(NAME f7_clock_register_mock COMMAND bobflight_f7_clock_test)
  add_executable(bobflight_scheduler_timing_test src/sched/scheduler.c tests/host_scheduler_timing.c)
  add_test(NAME scheduler_timing COMMAND bobflight_scheduler_timing_test)
  add_executable(bobflight_timing_cli_test tests/host_timing_cli.c)
  add_test(NAME timing_cli COMMAND bobflight_timing_cli_test)
  add_test(NAME boot_led_modes COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_boot_led_modes.py ${CMAKE_C_COMPILER})
  add_executable(bobflight_receiver_test src/drivers/rx.c src/drivers/crsf.c tests/host_receiver.c)
  target_link_libraries(bobflight_receiver_test m)
  add_test(NAME receiver COMMAND bobflight_receiver_test)
  add_executable(bobflight_power_test src/drivers/power.c tests/host_power.c)
  target_link_libraries(bobflight_power_test m)
  add_dependencies(bobflight_power_test bobflight_pins_gen)
  add_test(NAME power COMMAND bobflight_power_test)
  add_executable(bobflight_host ${BF_COMMON_SOURCES} src/hal/host/hal_host.c)
  add_test(NAME bootloader_host_binding COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_bootloader_binding.py $<TARGET_FILE:bobflight_host> ${CMAKE_SOURCE_DIR})
  target_link_libraries(bobflight_host m)
  add_dependencies(bobflight_host bobflight_pins_gen)
  target_compile_definitions(bobflight_host PRIVATE
    BOBFLIGHT_ACCEL_BENCH_RELAXED=$<BOOL:${BOBFLIGHT_ACCEL_BENCH_RELAXED}>
    BOBFLIGHT_HOST=1
    BOBFLIGHT_BOARD_ID="${BOBFLIGHT_BOARD}")
  message(STATUS "BobFlight: host smoke target 'bobflight_host'")

  add_executable(bobflight_rates_math_test
    src/flight/rates.c
    src/flight/config.c
    tests/host_rates_math.c)
  target_include_directories(bobflight_rates_math_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_rates_math_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_rates_math_test m)

  add_executable(bobflight_arming_edges_test
    src/flight/arming.c
    src/flight/failsafe.c
    tests/host_arming_edges.c)
  target_link_libraries(bobflight_arming_edges_test m)

  add_executable(bobflight_failsafe_test
    src/flight/arming.c
    src/flight/failsafe.c
    tests/host_failsafe.c)
  target_link_libraries(bobflight_failsafe_test m)

  add_executable(bobflight_dshot_speed_test
    src/flight/arming.c
    src/drivers/dshot.c
    tests/host_dshot_speed.c)
  target_include_directories(bobflight_dshot_speed_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_dshot_speed_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_dshot_speed_test m)
  target_include_directories(bobflight_arming_edges_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_arming_edges_test PRIVATE BOBFLIGHT_HOST=1)

  add_executable(bobflight_dshot_frame_test
    src/drivers/dshot.c
    tests/host_dshot_frame.c)
  target_include_directories(bobflight_dshot_frame_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_dshot_frame_test PRIVATE BOBFLIGHT_HOST=1)

  add_executable(bobflight_crsf_parse_test
    src/drivers/crsf.c
    tests/host_crsf_parse.c)
  target_include_directories(bobflight_crsf_parse_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_crsf_parse_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_crsf_parse_test m)

  add_executable(bobflight_gyro_inject_test
    src/drivers/gyro.c src/drivers/sensor_calibration.c
    tests/host_gyro_inject.c)
  target_include_directories(bobflight_gyro_inject_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_gyro_inject_test PRIVATE BOBFLIGHT_HOST=1)

  target_link_libraries(bobflight_gyro_inject_test m)
  add_executable(bobflight_sensor_cli_test tests/host_sensor_cli.c)
  add_test(NAME sensor_cli COMMAND bobflight_sensor_cli_test)
  add_executable(bobflight_accel_offset_test src/drivers/sensor_calibration.c tests/host_accel_offset.c)
  target_link_libraries(bobflight_accel_offset_test m)
  add_test(NAME accel_offset COMMAND bobflight_accel_offset_test)
  add_executable(bobflight_arming_calibration_test src/flight/arming.c src/flight/failsafe.c tests/host_arming_edges.c)
  target_compile_definitions(bobflight_arming_calibration_test PRIVATE BOBFLIGHT_MCU=1 BOBFLIGHT_FLIGHT_ENABLE=1)
  target_link_libraries(bobflight_arming_calibration_test m)
  add_test(NAME arming_calibration COMMAND bobflight_arming_calibration_test)
  foreach(policy IN ITEMS strict relaxed)
    add_executable(bobflight_accel_${policy}_policy_test src/drivers/sensor_calibration.c tests/host_accel_policy.c)
    target_link_libraries(bobflight_accel_${policy}_policy_test m)
    if(policy STREQUAL "relaxed")
      target_compile_definitions(bobflight_accel_${policy}_policy_test PRIVATE BOBFLIGHT_ACCEL_BENCH_RELAXED=1)
    endif()
    add_test(NAME accel_${policy}_policy COMMAND bobflight_accel_${policy}_policy_test)
  endforeach()
  add_executable(bobflight_relaxed_arming_test src/flight/arming.c src/flight/failsafe.c tests/host_relaxed_arming.c)
  target_compile_definitions(bobflight_relaxed_arming_test PRIVATE BOBFLIGHT_ACCEL_BENCH_RELAXED=1)
  target_link_libraries(bobflight_relaxed_arming_test m)
  add_test(NAME relaxed_arming COMMAND bobflight_relaxed_arming_test)
  add_test(NAME calibration_policy_guards COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_calibration_policy_guards.py ${CMAKE_C_COMPILER} ${CMAKE_COMMAND} ${CMAKE_SOURCE_DIR})
  add_executable(bobflight_sensor_calibration_test src/drivers/sensor_calibration.c tests/host_sensor_calibration.c)
  target_link_libraries(bobflight_sensor_calibration_test m)
  add_test(NAME sensor_calibration COMMAND bobflight_sensor_calibration_test)
  add_executable(bobflight_attitude_test src/flight/attitude.c tests/host_attitude.c)
  target_link_libraries(bobflight_attitude_test m)
  add_executable(bobflight_mpu6000_test src/drivers/gyro.c src/drivers/sensor_calibration.c tests/host_mpu6000.c)
  target_compile_definitions(bobflight_mpu6000_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_mpu6000_test m)
  add_executable(bobflight_mpu6000_relaxed_test src/drivers/gyro.c src/drivers/sensor_calibration.c tests/host_mpu6000.c)
  target_compile_definitions(bobflight_mpu6000_relaxed_test PRIVATE BOBFLIGHT_HOST=1 BOBFLIGHT_ACCEL_BENCH_RELAXED=1)
  target_link_libraries(bobflight_mpu6000_relaxed_test m)
  add_test(NAME mpu6000_relaxed COMMAND bobflight_mpu6000_relaxed_test)
  add_executable(bobflight_bench_safety_test
    src/sched/tasks.c src/flight/pid.c src/flight/mixer.c
    src/flight/attitude.c src/flight/config.c tests/host_bench_safety.c)
  target_compile_definitions(bobflight_bench_safety_test PRIVATE BOBFLIGHT_HOST=1)
  target_sources(bobflight_bench_safety_test PRIVATE src/flight/rates.c)
  target_sources(bobflight_bench_safety_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_bench_safety_test m)
  add_executable(bobflight_dshot_timer_test tests/host_dshot_timer.c)
  target_compile_definitions(bobflight_dshot_timer_test PRIVATE BOBFLIGHT_HOST=1)
  add_test(NAME dshot_timer COMMAND bobflight_dshot_timer_test)
  add_test(NAME cli_bench_protocol COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_cli_bench.py $<TARGET_FILE:bobflight_host>)
  foreach(check rates_math arming_edges failsafe dshot_frame dshot_speed crsf_parse gyro_inject cascade_inject attitude mpu6000 bench_safety)
    add_test(NAME ${check} COMMAND bobflight_${check}_test)
  endforeach()

  add_executable(bobflight_horizon_test src/flight/horizon.c src/flight/attitude.c
    src/flight/rates.c src/flight/config.c tests/host_horizon.c)
  target_link_libraries(bobflight_horizon_test m)
  add_test(NAME horizon_blend COMMAND bobflight_horizon_test)
  add_test(NAME flight_modes_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_flight_modes_cli.py $<TARGET_FILE:bobflight_host>)
  add_executable(bobflight_control_mode_test
    src/sched/tasks.c src/flight/pid.c src/flight/attitude.c
    src/flight/rates.c src/flight/config.c tests/host_control_mode.c)
  target_compile_definitions(bobflight_control_mode_test PRIVATE BOBFLIGHT_HOST=1)
  target_sources(bobflight_control_mode_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_control_mode_test m)
  add_test(NAME control_mode_routing COMMAND bobflight_control_mode_test)
  add_executable(bobflight_control_mode_flight_guard_test
    src/sched/tasks.c src/flight/pid.c src/flight/attitude.c
    src/flight/rates.c src/flight/config.c tests/host_control_mode.c)
  target_compile_definitions(bobflight_control_mode_flight_guard_test PRIVATE
    BOBFLIGHT_HOST=1 BOBFLIGHT_FLIGHT_ENABLE=1)
  target_sources(bobflight_control_mode_flight_guard_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_control_mode_flight_guard_test m)
  add_test(NAME control_mode_flight_guard COMMAND bobflight_control_mode_flight_guard_test)
  add_test(NAME control_mode_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_control_mode_cli.py $<TARGET_FILE:bobflight_host>)

  add_executable(bobflight_cascade_inject_test
    src/flight/pid.c
  src/flight/attitude.c
    src/flight/mixer.c
    src/flight/rates.c
    src/flight/config.c
    src/flight/arming.c
    src/flight/failsafe.c
    src/drivers/gyro.c src/drivers/sensor_calibration.c
    src/drivers/rx.c
    src/drivers/crsf.c
    src/board/ir_load.c
    src/hal/host/hal_host.c
    tests/host_cascade_inject.c)
  add_dependencies(bobflight_cascade_inject_test bobflight_pins_gen)
  target_include_directories(bobflight_cascade_inject_test PRIVATE
    ${CMAKE_BINARY_DIR}/generated
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_cascade_inject_test PRIVATE
    BOBFLIGHT_HOST=1
    BOBFLIGHT_BOARD_ID="${BOBFLIGHT_BOARD}")
  target_link_libraries(bobflight_cascade_inject_test m)
else()
  # Cross / MCU skeleton — HAL no-ops until CMSIS audited in
  # TinyUSB (MIT) — device CDC + DWC2 only; MCU builds only
  set(BF_TUSB_ROOT "${CMAKE_SOURCE_DIR}/third_party/tinyusb")
  set(BF_TUSB_SOURCES
    ${BF_TUSB_ROOT}/src/tusb.c
    ${BF_TUSB_ROOT}/src/common/tusb_fifo.c
    ${BF_TUSB_ROOT}/src/device/usbd.c
    ${BF_TUSB_ROOT}/src/class/cdc/cdc_device.c
    ${BF_TUSB_ROOT}/src/portable/synopsys/dwc2/dcd_dwc2.c
    ${BF_TUSB_ROOT}/src/portable/synopsys/dwc2/dwc2_common.c
    src/usb/usb_descriptors.c)

  add_executable(bobflight.elf
    ${BF_COMMON_SOURCES}
    src/hal/stm32f7/hal_f7_priv.c
    src/hal/stm32f7/hal_clock.c
    src/hal/stm32f7/hal_gpio.c
    src/hal/stm32f7/hal_spi.c
    src/hal/stm32f7/hal_adc.c
    src/hal/stm32f7/hal_uart.c
    src/hal/stm32f7/hal_tim_dma.c
    src/hal/stm32f7/hal_exti.c
    src/hal/stm32f7/hal_usb_cdc.c
    src/hal/stm32f7/hal_flash.c
    src/hal/stm32f7/hal_bootloader.c
    src/hal/stm32f7/startup_stm32f722.c
    ${BF_TUSB_SOURCES})
  add_dependencies(bobflight.elf bobflight_pins_gen)
  target_compile_definitions(bobflight.elf PRIVATE
    BOBFLIGHT_ACCEL_BENCH_RELAXED=$<BOOL:${BOBFLIGHT_ACCEL_BENCH_RELAXED}>
    BOBFLIGHT_MCU=1
    BOBFLIGHT_HAVE_CMSIS=1
    BOBFLIGHT_BOARD_ID="${BOBFLIGHT_BOARD}"
    CFG_TUSB_MCU=OPT_MCU_STM32F7)
  if(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv" AND BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_CONFIG_FLASH_F745=1)
  endif()
  if(BOBFLIGHT_FLIGHT_ENABLE)
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_FLIGHT_ENABLE=1)
  endif()
  if(BOBFLIGHT_PROVE_RESET)
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_PROVE_RESET=1)
    message(STATUS "BobFlight: BOBFLIGHT_PROVE_RESET=ON (Reset_Handler forever PA2 blink; no main)")
  endif()
  target_include_directories(bobflight.elf PRIVATE
    ${CMAKE_SOURCE_DIR}/third_party/cmsis-core/Include
    ${CMAKE_SOURCE_DIR}/src/hal/stm32f7
    ${BF_TUSB_ROOT}/src
    ${CMAKE_SOURCE_DIR}/src/usb)
  if(DEFINED BOBFLIGHT_TARGET_MCU)
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_TARGET_MCU=${BOBFLIGHT_TARGET_MCU})
  endif()
  # Prefer toolchain CACHE MCU; fall back to board id for Kakute F745.
  if(DEFINED BOBFLIGHT_TARGET_MCU AND BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")
    set(_BF_LD_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/stm32f745.ld")
  elseif(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv")
    set(_BF_LD_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/stm32f745.ld")
    if(NOT DEFINED BOBFLIGHT_TARGET_MCU)
      set(BOBFLIGHT_TARGET_MCU "STM32F745" CACHE STRING "MCU family")
    endif()
  else()
    set(_BF_LD_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/stm32f722.ld")
  endif()
  message(STATUS "BobFlight: linker ${_BF_LD_SCRIPT} MCU=${BOBFLIGHT_TARGET_MCU}")
  target_link_options(bobflight.elf PRIVATE
    -nostartfiles
    -specs=nosys.specs
    -T${_BF_LD_SCRIPT}
    -Wl,--gc-sections
    -Wl,-Map=${CMAKE_BINARY_DIR}/bobflight.map)
  target_link_libraries(bobflight.elf m)
  # ROM DFU artifacts when objcopy is available (cross toolchain sets it).
  find_program(BF_OBJCOPY arm-none-eabi-objcopy)
  if(BF_OBJCOPY)
    add_custom_command(TARGET bobflight.elf POST_BUILD
      COMMAND ${BF_OBJCOPY} -O ihex $<TARGET_FILE:bobflight.elf> ${CMAKE_BINARY_DIR}/bobflight.hex
      COMMAND ${BF_OBJCOPY} -O binary $<TARGET_FILE:bobflight.elf> ${CMAKE_BINARY_DIR}/bobflight.bin
      COMMENT "bobflight.hex / bobflight.bin")
    if(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2" OR BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv")
      add_custom_target(check_bootloader_image
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/check_tmotor_image.py" "${CMAKE_BINARY_DIR}/bobflight.hex" "${BOBFLIGHT_BOARD}"
        DEPENDS bobflight.elf VERBATIM)
    endif()
    if(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2")
      add_custom_command(TARGET bobflight.elf POST_BUILD
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/check_tmotor_image.py" "${CMAKE_BINARY_DIR}/bobflight.hex"
        VERBATIM)
      add_custom_target(check_tmotor_image
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/check_tmotor_image.py" "${CMAKE_BINARY_DIR}/bobflight.hex"
        DEPENDS bobflight.elf VERBATIM)
    endif()
  endif()
  if(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2" AND NOT BF_OBJCOPY)
    message(FATAL_ERROR "arm-none-eabi-objcopy is required for the TMOTORF7V2 image checker")
  endif()
  message(STATUS "BobFlight: MCU target 'bobflight.elf' (F7 HAL + ARM CMSIS Core; MMIO gated on verified IR)")
endif()
