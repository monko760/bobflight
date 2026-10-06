# SPDX-License-Identifier: Apache-2.0
# Exact implemented parts only. Never route an unknown MCU to a default HAL.
if(NOT DEFINED BOBFLIGHT_TARGET_MCU OR BOBFLIGHT_TARGET_MCU STREQUAL "")
  message(FATAL_ERROR "MCU backend requires explicit BOBFLIGHT_TARGET_MCU")
endif()
if(BOBFLIGHT_TARGET_MCU STREQUAL "STM32F722" OR BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")
  include("${CMAKE_CURRENT_LIST_DIR}/backends/stm32f7.cmake")
else()
  message(FATAL_ERROR "MCU ${BOBFLIGHT_TARGET_MCU} backend is not implemented; no fallback is permitted")
endif()
message(STATUS "BobFlight: backend ${BF_BACKEND_FAMILY} part ${BF_BACKEND_MCU}")
