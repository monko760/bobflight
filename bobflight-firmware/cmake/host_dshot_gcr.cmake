# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Host test for clean-room DShot GCR -> eRPM (R0a).

add_executable(bobflight_dshot_gcr_test
  src/drivers/dshot_gcr.c
  tests/host_dshot_gcr.c)
target_include_directories(bobflight_dshot_gcr_test PRIVATE
  ${CMAKE_SOURCE_DIR}/include
  ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(bobflight_dshot_gcr_test PRIVATE BOBFLIGHT_HOST=1)
add_test(NAME dshot_gcr COMMAND bobflight_dshot_gcr_test)
