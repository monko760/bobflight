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

# Target catalog is the source of board/MCU selection, not a hardcoded allowlist.
option(BOBFLIGHT_HOST_SMOKE "Build host smoke binary (no MCU)" ON)
set(BOBFLIGHT_BOARD "dummy" CACHE STRING "Board id from scripts/target_registry.py list")
execute_process(COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/target_registry.py"
  resolve "${BOBFLIGHT_BOARD}" --cmake RESULT_VARIABLE _target_rc
  OUTPUT_VARIABLE _target_cmake ERROR_VARIABLE _target_err)
if(NOT _target_rc EQUAL 0)
  message(FATAL_ERROR "Target definition rejected: ${_target_err}")
endif()
file(WRITE "${CMAKE_BINARY_DIR}/resolved-target.cmake" "${_target_cmake}")
include("${CMAKE_BINARY_DIR}/resolved-target.cmake")
set(BOBFLIGHT_IR_YAML "${CMAKE_SOURCE_DIR}/${BOBFLIGHT_IR_RELATIVE}")
file(GLOB _bf_target_defs CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/targets/mcus/*.json" "${CMAKE_SOURCE_DIR}/targets/boards/*.json")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_bf_target_defs}
  "${CMAKE_SOURCE_DIR}/scripts/target_registry.py" "${BOBFLIGHT_IR_YAML}")
if(CMAKE_CROSSCOMPILING)
  if(BOBFLIGHT_BOARD_SUPPORT STREQUAL "host-only" OR NOT BOBFLIGHT_MCU_STATUS STREQUAL "implemented")
    message(FATAL_ERROR "This target has no implemented hardware backend")
  endif()
  if(NOT BOBFLIGHT_TARGET_MCU STREQUAL BOBFLIGHT_EXPECTED_MCU)
    message(FATAL_ERROR "Board requires ${BOBFLIGHT_EXPECTED_MCU}, not ${BOBFLIGHT_TARGET_MCU}")
  endif()
  get_filename_component(_bf_selected_toolchain "${CMAKE_TOOLCHAIN_FILE}" REALPATH BASE_DIR "${CMAKE_SOURCE_DIR}")
  get_filename_component(_bf_expected_toolchain "${CMAKE_SOURCE_DIR}/${BOBFLIGHT_EXPECTED_TOOLCHAIN}" REALPATH)
  if(NOT _bf_selected_toolchain STREQUAL _bf_expected_toolchain)
    message(FATAL_ERROR "Target toolchain does not match the board definition")
  endif()
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

# One supported image per hardware target. Reject stale build-profile caches
# rather than silently changing the meaning of a previous bench command.
if(DEFINED BOBFLIGHT_FLIGHT_ENABLE)
  message(FATAL_ERROR "BOBFLIGHT_FLIGHT_ENABLE is retired. Use build-main.ps1 in a fresh build-main directory for Kakute; use the sensor script for TMOTORF7V2.")
endif()
option(BOBFLIGHT_ACCEL_BENCH_RELAXED "Experimental relaxed accel checks; native tests only" OFF)
if(BOBFLIGHT_ACCEL_BENCH_RELAXED AND (CMAKE_CROSSCOMPILING OR NOT BOBFLIGHT_HOST_SMOKE))
  message(FATAL_ERROR "Relaxed accelerometer checks are host-test-only: MCU images never relax sensor qualification")
endif()
# TMOTORF7V2 has no motor backend: this is a hardware limit, not a user profile.
if(BOBFLIGHT_BOARD STREQUAL "tmotor_f7_v2")
  if(BOBFLIGHT_ACCEL_BENCH_RELAXED)
    message(FATAL_ERROR "TMOTORF7V2 sensor bring-up requires relaxed calibration OFF")
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
  src/sched/loop_rate.c
  src/sched/loop_rate_setting.c
  src/sched/tasks.c
  src/flight/pid.c src/flight/filter.c src/flight/rpm_filter.c
  src/flight/flight_recorder.c src/flight/blackbox_encode.c src/flight/blackbox_capture.c src/flight/blackbox_session.c
  src/drivers/sd_spi.c src/drivers/sd_probe.c src/drivers/fat32_log.c
  src/flight/pid_diag.c src/flight/pid_diag_core.c
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
  src/drivers/dshot_gcr.c
  src/drivers/dshot_telem.c src/drivers/rpm_filter_gyro.c
  src/drivers/blackbox_inputs.c
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
  add_test(NAME target_registry_validation COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tests/test_target_registry.py)
  add_test(NAME target_artifact_publication COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tests/test_target_artifact.py)
  add_executable(bobflight_capture_test src/flight/blackbox_capture.c src/flight/flight_recorder.c src/flight/pid.c src/flight/filter.c src/flight/config.c tests/host_blackbox_capture.c)
  target_link_libraries(bobflight_capture_test m)
  add_test(NAME blackbox_production_capture COMMAND bobflight_capture_test)
  add_executable(bobflight_recorder_test src/flight/flight_recorder.c tests/host_flight_recorder.c)
  target_link_libraries(bobflight_recorder_test m)
  add_test(NAME flight_recorder_bounded COMMAND bobflight_recorder_test)
  set_tests_properties(flight_recorder_bounded PROPERTIES TIMEOUT 5)
  add_executable(bobflight_blackbox_health_test tests/host_blackbox_health.c)
  add_test(NAME blackbox_status_health_readouts COMMAND bobflight_blackbox_health_test)
  add_executable(bobflight_blackbox_encode_test src/flight/blackbox_encode.c src/flight/config.c tests/host_blackbox_encode.c)
  target_link_libraries(bobflight_blackbox_encode_test m)
  add_test(NAME blackbox_encode COMMAND bobflight_blackbox_encode_test)
  add_test(NAME blackbox_schema3_decode COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_blackbox_decode.py $<TARGET_FILE:bobflight_blackbox_encode_test>)
  add_executable(bobflight_pid_trace_test src/flight/pid.c src/flight/filter.c src/flight/config.c tests/pid_pr38_baseline.c tests/host_pid_trace.c)
  target_link_libraries(bobflight_pid_trace_test m)
  add_test(NAME pid_trace_bit_exact COMMAND bobflight_pid_trace_test)
  add_executable(bobflight_sd_probe_test src/drivers/sd_probe.c src/drivers/sd_spi.c tests/host_sd_probe.c)
  add_test(NAME sd_readonly_probe COMMAND bobflight_sd_probe_test)
  add_executable(bobflight_sd_read_cli_test src/drivers/sd_probe.c src/drivers/sd_spi.c tests/host_sd_read_cli.c)
  add_test(NAME sd_read_cli_guards COMMAND bobflight_sd_read_cli_test)
  add_executable(bobflight_sd_cli_test src/drivers/sd_probe.c src/drivers/sd_spi.c tests/host_sd_cli.c)
  add_test(NAME sd_cli_guards COMMAND bobflight_sd_cli_test)
  add_executable(bobflight_sd_gpio_input_test tests/host_sd_gpio_input.c src/drivers/sd_spi.c)
  add_test(NAME sd_real_gpio_input COMMAND bobflight_sd_gpio_input_test)
  add_executable(bobflight_sd_spi_hw_test tests/host_sd_spi_hw.c)
  add_test(NAME sd_spi_hw_nonblocking COMMAND bobflight_sd_spi_hw_test)
  add_executable(bobflight_sd_spi_test src/drivers/sd_spi.c tests/host_sd_spi.c)
  add_test(NAME sd_spi_transport COMMAND bobflight_sd_spi_test)
  set_tests_properties(sd_spi_transport PROPERTIES TIMEOUT 10)
  # Native audit of actual scheduler -> RX/failsafe -> PID/mixer -> DShot packets.
  # Hardware and diagnostic telemetry hook are mocked; never enables MCU arming.
  add_executable(bobflight_failsafe_integration_test
    tests/host_failsafe_integration.c
    src/sched/scheduler.c src/sched/tasks.c
    src/drivers/rx.c src/drivers/crsf.c src/drivers/dshot.c
    src/flight/arming.c src/flight/failsafe.c src/flight/attitude.c
    src/flight/config.c src/flight/pid.c src/flight/filter.c src/flight/rates.c
    src/flight/horizon.c src/flight/mode_range.c src/flight/mixer.c)
  target_compile_definitions(bobflight_failsafe_integration_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_failsafe_integration_test m)
  foreach(fs_case boot drop drop-wrap bad-traffic repeated-valid land-throttle
      land-disarm land-timer gyro-fault nonfinite-sensor scheduler-gap
      dma-failure direct-disarm usb-flight-path
      arm-aux12-output arm-start-active arm-edit-edge arm-aba-edge arm-disabled
      arm-stale-edge arm-throttle-edge arm-bench-edge arm-calibration-edge arm-health-edge
      arm-middle-range arm-inclusive-boundaries arm-always-active arm-custom-land
      arm-custom-hold arm-config-independent-source arm-tilt-edge arm-uncalibrated-edge
      link-lq-zero link-stats-stale link-rf-mode-low link-absent link-recovery)
    add_test(NAME failsafe_integration_${fs_case}
      COMMAND bobflight_failsafe_integration_test ${fs_case})
  endforeach()
  add_executable(bobflight_pid_diag_task_test tests/host_pid_diag_task.c
    src/sched/scheduler.c src/sched/tasks.c src/flight/pid_diag.c src/flight/pid_diag_core.c src/flight/pid.c src/flight/filter.c
    src/flight/mixer.c src/flight/attitude.c src/flight/config.c src/flight/rates.c
    src/flight/mode_range.c src/flight/horizon.c)
  target_compile_definitions(bobflight_pid_diag_task_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_pid_diag_task_test m)
  add_test(NAME pid_diag_task COMMAND bobflight_pid_diag_task_test)
  add_executable(bobflight_pid_diag_test tests/host_pid_diag.c
    src/flight/pid_diag.c src/flight/pid_diag_core.c src/flight/pid.c src/flight/filter.c src/flight/config.c src/flight/rates.c)
  target_compile_definitions(bobflight_pid_diag_test PRIVATE BOBFLIGHT_FLIGHT_ENABLE=1)
  target_link_libraries(bobflight_pid_diag_test m)
  add_test(NAME pid_diag_normal COMMAND bobflight_pid_diag_test)
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
  add_executable(bobflight_persist_config_test tests/host_persist_config.c src/sched/loop_rate_setting.c src/flight/config.c src/flight/mode_range.c src/drivers/sensor_calibration.c src/drivers/power.c)
  target_link_libraries(bobflight_persist_config_test m)
  add_test(NAME persist_config COMMAND bobflight_persist_config_test)
  add_executable(bobflight_pid_aw_test src/flight/pid.c src/flight/filter.c src/flight/config.c tests/host_pid_aw.c)
  target_link_libraries(bobflight_pid_aw_test m)
  add_test(NAME pid_aw COMMAND bobflight_pid_aw_test)
  add_executable(bobflight_mixer_idle_test src/flight/mixer.c src/flight/config.c tests/host_mixer_idle.c)
  target_link_libraries(bobflight_mixer_idle_test m)
  add_test(NAME mixer_idle COMMAND bobflight_mixer_idle_test)
  add_executable(bobflight_mixer_direction_test src/flight/mixer.c src/flight/config.c src/flight/pid.c src/flight/filter.c tests/host_mixer_direction.c)
  target_link_libraries(bobflight_mixer_direction_test m)
  add_test(NAME mixer_direction COMMAND bobflight_mixer_direction_test)
  add_executable(bobflight_motor_direction_cli_test src/flight/mixer.c src/flight/config.c src/flight/pid.c src/flight/filter.c tests/host_motor_direction_cli.c)
  target_link_libraries(bobflight_motor_direction_cli_test m)
  add_test(NAME motor_direction_cli_unit COMMAND bobflight_motor_direction_cli_test)
  # Safety S1 (docs/SAFETY-NOISE.md): PID anti-windup + D-term order unit test,
  # and HF-noise rectification through the real scheduler/PID/mixer/filters.
  add_executable(bobflight_pid_s1_test src/flight/pid.c src/flight/filter.c src/flight/config.c tests/host_pid_s1.c)
  target_link_libraries(bobflight_pid_s1_test m)
  add_test(NAME pid_s1_antiwindup_dterm COMMAND bobflight_pid_s1_test)
  add_executable(bobflight_noise_saturation_test
    tests/host_noise_saturation.c
    src/sched/scheduler.c src/sched/tasks.c
    src/drivers/rx.c src/drivers/crsf.c src/drivers/dshot.c
    src/flight/arming.c src/flight/failsafe.c src/flight/attitude.c
    src/flight/config.c src/flight/pid.c src/flight/filter.c src/flight/rates.c
    src/flight/horizon.c src/flight/mode_range.c src/flight/mixer.c)
  target_compile_definitions(bobflight_noise_saturation_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_noise_saturation_test m)
  add_test(NAME noise_saturation COMMAND bobflight_noise_saturation_test --table)
  set_tests_properties(noise_saturation PROPERTIES TIMEOUT 120)
  # QA F3: the RPM post-filter runs inside the gyro chain, per gyro sample (real gyro.c target chain).
  add_executable(bobflight_gyro_post_filter_chain_test tests/host_gyro_post_filter_chain.c
    src/drivers/gyro.c src/drivers/sensor_calibration.c
    src/sched/scheduler.c src/sched/tasks.c
    src/drivers/rx.c src/drivers/crsf.c src/drivers/dshot.c
    src/flight/arming.c src/flight/failsafe.c src/flight/attitude.c
    src/flight/config.c src/flight/pid.c src/flight/filter.c src/flight/rates.c
    src/flight/horizon.c src/flight/mode_range.c src/flight/mixer.c)
  target_compile_definitions(bobflight_gyro_post_filter_chain_test PRIVATE BOBFLIGHT_HOST=1 BOBFLIGHT_HOST_GYRO_CHAIN=1)
  target_link_libraries(bobflight_gyro_post_filter_chain_test m)
  add_test(NAME gyro_post_filter_chain COMMAND bobflight_gyro_post_filter_chain_test)
  # Real app_init (init.c) picks the D-term filter order from the configured gyro ODR.
  add_executable(bobflight_init_dterm_order_test tests/host_init_dterm_order.c src/app/init.c
    src/flight/pid.c src/flight/filter.c src/flight/config.c src/sched/loop_rate_setting.c)
  add_dependencies(bobflight_init_dterm_order_test bobflight_pins_gen)
  target_compile_definitions(bobflight_init_dterm_order_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_init_dterm_order_test m)
  add_test(NAME init_dterm_order COMMAND bobflight_init_dterm_order_test)
  # Report bytes: status byte-identical to b77b845; filters only filters_sample_hz (Kakute 4000 -> 8000).
  add_test(NAME report_bytes_contract COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_report_bytes_contract.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  # Report contract: status/filters/loop_rate/receiver keys and order equal b77b845.
  add_test(NAME report_keys_contract COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_report_keys_contract.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  add_executable(bobflight_legacy_p54_migration_test tests/host_legacy_p54_migration.c src/sched/loop_rate_setting.c src/flight/config.c src/flight/mode_range.c src/drivers/sensor_calibration.c src/drivers/power.c)
  target_link_libraries(bobflight_legacy_p54_migration_test m)
  add_test(NAME legacy_p54_migration COMMAND bobflight_legacy_p54_migration_test)
  add_executable(bobflight_storage_cli_test src/flight/config.c src/sched/loop_rate_setting.c tests/host_storage_cli.c)
  target_link_libraries(bobflight_storage_cli_test m)
  add_test(NAME storage_cli COMMAND bobflight_storage_cli_test)
  add_executable(bobflight_mode_range_test src/flight/mode_range.c tests/host_mode_range.c)
  target_link_libraries(bobflight_mode_range_test m)
  add_test(NAME mode_range COMMAND bobflight_mode_range_test)
  add_executable(bobflight_pid_elapsed_test src/sched/scheduler.c src/sched/tasks.c src/flight/attitude.c tests/host_pid_elapsed.c)
  target_sources(bobflight_pid_elapsed_test PRIVATE src/flight/rates.c src/flight/config.c)
  target_sources(bobflight_pid_elapsed_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_pid_elapsed_test m)
  add_test(NAME pid_elapsed COMMAND bobflight_pid_elapsed_test)
  add_executable(bobflight_loop_dt_test src/sched/scheduler.c src/sched/tasks.c src/flight/attitude.c tests/host_loop_dt.c)
  target_sources(bobflight_loop_dt_test PRIVATE src/flight/rates.c src/flight/config.c)
  target_sources(bobflight_loop_dt_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_loop_dt_test m)
  add_test(NAME loop_dt_follows_rate COMMAND bobflight_loop_dt_test)
  add_executable(bobflight_cycle_clock_test tests/host_cycle_clock.c)
  add_test(NAME cycle_clock COMMAND bobflight_cycle_clock_test)
  add_executable(bobflight_f7_clock_test src/hal/stm32f7/hal_clock.c tests/host_f7_clock.c)
  target_compile_options(bobflight_f7_clock_test PRIVATE -include ${CMAKE_SOURCE_DIR}/tests/clock_hw_mock.h)
  add_test(NAME f7_clock_register_mock COMMAND bobflight_f7_clock_test)
  add_executable(bobflight_scheduler_timing_test src/sched/scheduler.c tests/host_scheduler_timing.c)
  add_test(NAME scheduler_timing COMMAND bobflight_scheduler_timing_test)
  add_executable(bobflight_loop_rate_test src/sched/scheduler.c src/sched/loop_rate.c src/sched/loop_rate_setting.c tests/host_loop_rate.c)
  add_test(NAME loop_rate_policy_status COMMAND bobflight_loop_rate_test)
  add_executable(bobflight_timing_cli_test tests/host_timing_cli.c)
  add_test(NAME timing_cli COMMAND bobflight_timing_cli_test)
  # Future F4 backend component only. Never linked into hardware images yet.
  add_executable(bobflight_f4_clock_plan_test
    tests/host_f4_clock_plan.c src/hal/stm32f4/clock_plan.c)
  target_include_directories(bobflight_f4_clock_plan_test PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_compile_options(bobflight_f4_clock_plan_test PRIVATE -UNDEBUG)
  add_test(NAME f4_clock_plan COMMAND bobflight_f4_clock_plan_test)
  # Isolated clock-start component, never selected by a hardware target.
  add_executable(bobflight_f4_clock_start_test
    tests/host_f4_clock_start.c src/hal/stm32f4/clock_start.c
    src/hal/stm32f4/clock_plan.c)
  target_include_directories(bobflight_f4_clock_start_test PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_compile_options(bobflight_f4_clock_start_test PRIVATE -UNDEBUG)
  add_test(NAME f4_clock_start COMMAND bobflight_f4_clock_start_test)
  # Optional locally; mandatory in the dedicated ARM-component CI job.
  find_program(BOBFLIGHT_COMPONENT_ARM_GCC arm-none-eabi-gcc)
  execute_process(COMMAND ${Python3_EXECUTABLE} -c "import unicorn, elftools"
    RESULT_VARIABLE _bf_f4_model_deps OUTPUT_QUIET ERROR_QUIET)
  if(BOBFLIGHT_COMPONENT_ARM_GCC AND _bf_f4_model_deps EQUAL 0)
    add_test(NAME f4_startup_layout COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_SOURCE_DIR}/tests/test_f4_startup_layout.py)
    add_test(NAME f405_clock_mmio COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_SOURCE_DIR}/tests/test_f405_clock_mmio.py)
    add_test(NAME f405_timebase COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_SOURCE_DIR}/tests/test_f405_timebase.py)
    add_test(NAME f405_usb_link COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_SOURCE_DIR}/tests/test_f405_usb_link.py)
    add_test(NAME f405_usb_prepare COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_SOURCE_DIR}/tests/test_f405_usb_prepare.py)
  else()
    message(STATUS "F4 startup component tests need ARM GCC and tests/f4-component-requirements.txt; dedicated CI runs them")
  endif()
  add_test(NAME mcu_backend_selection COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/test_mcu_backend_selection.py ${CMAKE_COMMAND} ${CMAKE_C_COMPILER})
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
  target_compile_definitions(bobflight_host PRIVATE BOBFLIGHT_FLIGHT_ENABLE=1)
  add_test(NAME bootloader_host_binding COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_bootloader_binding.py $<TARGET_FILE:bobflight_host> ${CMAKE_SOURCE_DIR})
  target_link_libraries(bobflight_host m)
  add_dependencies(bobflight_host bobflight_pins_gen)
  target_compile_definitions(bobflight_host PRIVATE
    BOBFLIGHT_ACCEL_BENCH_RELAXED=$<BOOL:${BOBFLIGHT_ACCEL_BENCH_RELAXED}>
    BOBFLIGHT_HOST=1
    BOBFLIGHT_BOARD_ID="${BOBFLIGHT_BOARD}")
  message(STATUS "BobFlight: host smoke target 'bobflight_host'")

  add_executable(bobflight_filter_test
    src/flight/filter.c
    src/flight/config.c
    tests/host_filter.c)
  target_include_directories(bobflight_filter_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_filter_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_filter_test m)
  add_test(NAME filter_lpf_math COMMAND bobflight_filter_test)

  add_executable(bobflight_filter_notch_test
    src/flight/filter.c
    src/flight/config.c
    tests/host_filter_notch.c)
  target_include_directories(bobflight_filter_notch_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_filter_notch_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_filter_notch_test m)
  add_test(NAME filter_notch COMMAND bobflight_filter_notch_test)

  add_executable(bobflight_rpm_filter_test
    src/flight/filter.c
    src/flight/rpm_filter.c
    tests/host_rpm_filter.c)
  target_include_directories(bobflight_rpm_filter_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_rpm_filter_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_rpm_filter_test m)
  add_test(NAME rpm_filter COMMAND bobflight_rpm_filter_test)
  add_executable(bobflight_blackbox_inputs_test tests/host_blackbox_inputs.c
    src/drivers/blackbox_inputs.c src/drivers/rpm_filter_gyro.c src/flight/rpm_filter.c
    src/flight/filter.c src/flight/config.c)
  target_compile_definitions(bobflight_blackbox_inputs_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_blackbox_inputs_test m)
  add_test(NAME blackbox_schema3_inputs COMMAND bobflight_blackbox_inputs_test)

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
  target_include_directories(bobflight_arming_edges_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_arming_edges_test PRIVATE BOBFLIGHT_HOST=1)

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

  include(${CMAKE_SOURCE_DIR}/cmake/host_dshot_gcr.cmake)
  include(${CMAKE_SOURCE_DIR}/cmake/host_dshot_telem.cmake)

  add_executable(bobflight_crsf_parse_test
    src/drivers/crsf.c
    tests/host_crsf_parse.c)
  target_include_directories(bobflight_crsf_parse_test PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src)
  target_compile_definitions(bobflight_crsf_parse_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_crsf_parse_test m)

  add_executable(bobflight_gyro_inject_test
    src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/filter.c src/flight/config.c
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
  add_executable(bobflight_pid_mpu_freshness_test tests/host_pid_mpu_freshness.c
    src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/pid_diag.c
    src/flight/pid_diag_core.c src/flight/pid.c src/flight/filter.c src/flight/config.c src/flight/rates.c)
  target_compile_definitions(bobflight_pid_mpu_freshness_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_pid_mpu_freshness_test m)
  add_test(NAME pid_mpu_freshness COMMAND bobflight_pid_mpu_freshness_test)
  add_executable(bobflight_imu_orientation_math_test tests/host_imu_orientation_math.c)
  add_test(NAME imu_orientation_math COMMAND bobflight_imu_orientation_math_test)
  foreach(host_mode 0 1)
    add_executable(bobflight_imu_orientation_driver_${host_mode}
      src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/filter.c
      src/flight/config.c src/sched/loop_rate_setting.c tests/host_imu_orientation_driver.c)
    target_compile_definitions(bobflight_imu_orientation_driver_${host_mode} PRIVATE BOBFLIGHT_HOST=${host_mode})
    target_link_libraries(bobflight_imu_orientation_driver_${host_mode} m)
    add_test(NAME imu_orientation_driver_${host_mode} COMMAND bobflight_imu_orientation_driver_${host_mode})
  endforeach()
  add_test(NAME imu_orientation_ir COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tests/test_imu_orientation_ir.py)
  add_executable(bobflight_mpu6000_test src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/filter.c src/flight/config.c tests/host_mpu6000.c)
  target_compile_definitions(bobflight_mpu6000_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_mpu6000_test m)
  add_executable(bobflight_gyro_health_test src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/filter.c src/flight/config.c src/flight/arming.c tests/host_gyro_health.c)
  target_compile_definitions(bobflight_gyro_health_test PRIVATE BOBFLIGHT_HOST=1)
  target_link_libraries(bobflight_gyro_health_test m)
  add_test(NAME gyro_health COMMAND bobflight_gyro_health_test)
  add_executable(bobflight_mpu6000_relaxed_test src/drivers/gyro.c src/drivers/sensor_calibration.c src/flight/filter.c src/flight/config.c tests/host_mpu6000.c)
  target_compile_definitions(bobflight_mpu6000_relaxed_test PRIVATE BOBFLIGHT_HOST=1 BOBFLIGHT_ACCEL_BENCH_RELAXED=1)
  target_link_libraries(bobflight_mpu6000_relaxed_test m)
  add_test(NAME mpu6000_relaxed COMMAND bobflight_mpu6000_relaxed_test)
  add_executable(bobflight_bench_safety_test
    src/sched/scheduler.c src/sched/tasks.c src/flight/pid.c src/flight/filter.c src/flight/mixer.c
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
  foreach(check filter rates_math arming_edges failsafe dshot_frame dshot_speed crsf_parse gyro_inject cascade_inject attitude mpu6000 bench_safety)
    add_test(NAME ${check} COMMAND bobflight_${check}_test)
  endforeach()

  add_executable(bobflight_horizon_test src/flight/horizon.c src/flight/attitude.c
    src/flight/rates.c src/flight/config.c tests/host_horizon.c)
  target_link_libraries(bobflight_horizon_test m)
  add_test(NAME horizon_blend COMMAND bobflight_horizon_test)
  add_test(NAME flight_modes_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_flight_modes_cli.py $<TARGET_FILE:bobflight_host>)
  add_executable(bobflight_control_mode_test
    src/sched/scheduler.c src/sched/tasks.c src/flight/pid.c src/flight/filter.c src/flight/attitude.c
    src/flight/rates.c src/flight/config.c tests/host_control_mode.c)
  target_compile_definitions(bobflight_control_mode_test PRIVATE BOBFLIGHT_HOST=1 BOBFLIGHT_FLIGHT_ENABLE=1)
  target_sources(bobflight_control_mode_test PRIVATE src/flight/mode_range.c src/flight/horizon.c)
  target_link_libraries(bobflight_control_mode_test m)
  add_test(NAME control_mode_routing COMMAND bobflight_control_mode_test)
  add_test(NAME control_mode_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_control_mode_cli.py $<TARGET_FILE:bobflight_host>)
  add_test(NAME loop_status_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_loop_status_cli.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  add_test(NAME loop_rate_setting_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_loop_rate_setting_cli.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  add_test(NAME gyro_notch_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_gyro_notch_cli.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  add_test(NAME rpm_filter_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_rpm_filter_cli.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})
  add_test(NAME motor_direction_cli COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_SOURCE_DIR}/tests/host_motor_direction_cli.py $<TARGET_FILE:bobflight_host> ${BOBFLIGHT_BOARD})

  foreach(task_test pid_elapsed loop_dt bench_safety control_mode)
    target_sources(bobflight_${task_test}_test PRIVATE tests/pid_diag_stub.c)
  endforeach()
  # Filters R0: loop_filter() needs gyro_filter_set_dt; these targets stub gyro_filter
  # and cannot link drivers/gyro.c, so provide a host-only no-op.
  foreach(task_test failsafe_integration pid_diag_task pid_elapsed bench_safety control_mode)
    target_sources(bobflight_${task_test}_test PRIVATE tests/gyro_filter_dt_stub.c)
  endforeach()
  get_target_property(BB_TASK_SOURCES bobflight_control_mode_test SOURCES)
  list(REMOVE_ITEM BB_TASK_SOURCES tests/host_control_mode.c)
  add_executable(bobflight_blackbox_task_test ${BB_TASK_SOURCES}
    tests/host_blackbox_task.c src/flight/blackbox_capture.c src/flight/flight_recorder.c)
  target_compile_definitions(bobflight_blackbox_task_test PRIVATE BOBFLIGHT_HOST=1 BOBFLIGHT_FLIGHT_ENABLE=1 BOBFLIGHT_CAPTURE_TASK_TEST=1)
  target_link_libraries(bobflight_blackbox_task_test m)
  add_test(NAME blackbox_actual_cascade COMMAND bobflight_blackbox_task_test)
  add_executable(bobflight_blackbox_session_test tests/host_blackbox_session.c
    src/flight/blackbox_session.c src/flight/blackbox_capture.c src/flight/flight_recorder.c
    src/flight/blackbox_encode.c src/flight/pid.c src/flight/filter.c src/flight/config.c)
  target_link_libraries(bobflight_blackbox_session_test m)
  add_test(NAME blackbox_session_end_to_end COMMAND bobflight_blackbox_session_test)
  add_executable(bobflight_blackbox_cli_test tests/host_blackbox_cli.c
    src/drivers/sd_spi.c src/drivers/sd_probe.c src/drivers/fat32_log.c
    src/flight/blackbox_session.c src/flight/blackbox_capture.c src/flight/flight_recorder.c
    src/flight/blackbox_encode.c src/flight/pid.c src/flight/filter.c src/flight/config.c)
  target_link_libraries(bobflight_blackbox_cli_test m)
  add_test(NAME blackbox_cli_guards COMMAND bobflight_blackbox_cli_test)
  add_executable(bobflight_blackbox_throughput_test tests/host_blackbox_throughput.c
    src/drivers/sd_spi.c src/drivers/sd_probe.c src/drivers/fat32_log.c
    src/flight/blackbox_session.c src/flight/blackbox_capture.c src/flight/flight_recorder.c
    src/flight/blackbox_encode.c src/flight/pid.c src/flight/filter.c src/flight/config.c)
  target_link_libraries(bobflight_blackbox_throughput_test m)
  add_test(NAME blackbox_sd_throughput_model COMMAND bobflight_blackbox_throughput_test)
  set_tests_properties(blackbox_sd_throughput_model PROPERTIES TIMEOUT 300)
  # Same model with the recorder default raised to 1000 Hz (drop matrix at 1 kHz).
  get_target_property(BB_THROUGHPUT_SOURCES bobflight_blackbox_throughput_test SOURCES)
  add_executable(bobflight_blackbox_throughput_1k_test ${BB_THROUGHPUT_SOURCES})
  target_compile_definitions(bobflight_blackbox_throughput_1k_test PRIVATE BLACKBOX_RATE_DEFAULT_HZ=1000u)
  target_link_libraries(bobflight_blackbox_throughput_1k_test m)
  add_test(NAME blackbox_sd_throughput_model_1k COMMAND bobflight_blackbox_throughput_1k_test)
  set_tests_properties(blackbox_sd_throughput_model_1k PROPERTIES TIMEOUT 300)
  add_executable(bobflight_blackbox_card_test tests/host_blackbox_card.c
    src/drivers/fat32_log.c src/flight/blackbox_session.c src/flight/blackbox_capture.c
    src/flight/flight_recorder.c src/flight/blackbox_encode.c src/flight/pid.c src/flight/filter.c src/flight/config.c)
  target_link_libraries(bobflight_blackbox_card_test m)
  add_test(NAME blackbox_real_fat32_file COMMAND bobflight_blackbox_card_test)
  set_tests_properties(blackbox_real_fat32_file PROPERTIES TIMEOUT 30)
  get_target_property(BB_DIR_EDGE_SOURCES bobflight_blackbox_card_test SOURCES)
  list(REMOVE_ITEM BB_DIR_EDGE_SOURCES tests/host_blackbox_card.c)
  add_executable(bobflight_blackbox_directory_edge_test tests/host_blackbox_directory_edge.c ${BB_DIR_EDGE_SOURCES})
  target_link_libraries(bobflight_blackbox_directory_edge_test m)
  add_test(NAME blackbox_root_boundary_preservation COMMAND bobflight_blackbox_directory_edge_test)
  set_tests_properties(blackbox_root_boundary_preservation PROPERTIES TIMEOUT 30)
  add_executable(bobflight_blackbox_corruption_test tests/host_blackbox_corruption.c
    src/drivers/fat32_log.c src/flight/blackbox_session.c src/flight/blackbox_capture.c
    src/flight/flight_recorder.c src/flight/blackbox_encode.c src/flight/pid.c src/flight/filter.c src/flight/config.c)
  target_link_libraries(bobflight_blackbox_corruption_test m)
  add_test(NAME blackbox_independent_corruption_guards COMMAND bobflight_blackbox_corruption_test)
  set_tests_properties(blackbox_independent_corruption_guards PROPERTIES TIMEOUT 30)
  add_executable(bobflight_fat32_test tests/host_fat32_log.c src/drivers/fat32_log.c)
  add_test(NAME fat32_new_log_preservation COMMAND bobflight_fat32_test)
  set_tests_properties(blackbox_actual_cascade blackbox_session_end_to_end fat32_new_log_preservation PROPERTIES TIMEOUT 30)
  add_executable(bobflight_cascade_inject_test
    src/flight/pid.c src/flight/filter.c
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
  # Explicit MCU backend contract. Unsupported parts have no default fallback.
  include("${CMAKE_SOURCE_DIR}/cmake/select_mcu_backend.cmake")
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
    ${BF_HAL_SOURCES}
    ${BF_TUSB_SOURCES})
  add_dependencies(bobflight.elf bobflight_pins_gen)
  target_compile_definitions(bobflight.elf PRIVATE
    BOBFLIGHT_ACCEL_BENCH_RELAXED=$<BOOL:${BOBFLIGHT_ACCEL_BENCH_RELAXED}>
    BOBFLIGHT_MCU=1
    BOBFLIGHT_HAVE_CMSIS=1
    BOBFLIGHT_BOARD_ID="${BOBFLIGHT_BOARD}"
    CFG_TUSB_MCU=${BF_USB_MCU})
  if(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv" AND BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_CONFIG_FLASH_F745=1)
  endif()
  # Kakute has an implemented motor backend; all normal runtime guards remain.
  if(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv")
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_FLIGHT_ENABLE=1)
  endif()
  if(BOBFLIGHT_PROVE_RESET)
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_PROVE_RESET=1)
    message(STATUS "BobFlight: BOBFLIGHT_PROVE_RESET=ON (Reset_Handler forever PA2 blink; no main)")
  endif()
  target_include_directories(bobflight.elf PRIVATE
    ${CMAKE_SOURCE_DIR}/third_party/cmsis-core/Include
    ${BF_HAL_INCLUDE_DIRS}
    ${BF_TUSB_ROOT}/src
    ${CMAKE_SOURCE_DIR}/src/usb)
  if(DEFINED BOBFLIGHT_TARGET_MCU)
    target_compile_definitions(bobflight.elf PRIVATE BOBFLIGHT_TARGET_MCU=${BOBFLIGHT_TARGET_MCU})
  endif()
  set(_BF_LD_SCRIPT "${BF_LINKER_SCRIPT}")
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
