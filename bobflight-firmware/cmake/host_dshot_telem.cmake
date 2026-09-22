# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Host test for DShot R0b M1 telem: encode telem bit + GCR ingest → eRPM.

add_executable(bobflight_dshot_telem_test
  src/drivers/dshot.c
  src/drivers/dshot_gcr.c
  src/drivers/dshot_telem.c
  tests/host_dshot_telem.c)
target_include_directories(bobflight_dshot_telem_test PRIVATE
  ${CMAKE_SOURCE_DIR}/include
  ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(bobflight_dshot_telem_test PRIVATE BOBFLIGHT_HOST=1)
target_link_libraries(bobflight_dshot_telem_test m)
add_test(NAME dshot_telem_r0b COMMAND bobflight_dshot_telem_test)
