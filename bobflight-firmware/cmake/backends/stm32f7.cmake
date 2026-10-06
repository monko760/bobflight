# SPDX-License-Identifier: Apache-2.0
# Existing implemented F7 backend. Source order and runtime policy are unchanged.
get_filename_component(_BF_FIRMWARE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
set(BF_BACKEND_FAMILY "F7")
set(BF_BACKEND_MCU "${BOBFLIGHT_TARGET_MCU}")
if(BOBFLIGHT_TARGET_MCU STREQUAL "STM32F722")
  set(BF_LINKER_SCRIPT "${_BF_FIRMWARE_ROOT}/cmake/stm32f722.ld")
elseif(BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")
  set(BF_LINKER_SCRIPT "${_BF_FIRMWARE_ROOT}/cmake/stm32f745.ld")
else()
  message(FATAL_ERROR "F7 backend does not implement ${BOBFLIGHT_TARGET_MCU}")
endif()
set(BF_USB_MCU OPT_MCU_STM32F7)
set(BF_HAL_INCLUDE_DIRS "${_BF_FIRMWARE_ROOT}/src/hal/stm32f7")
set(BF_HAL_SOURCES
  src/hal/stm32f7/hal_f7_priv.c
  src/hal/stm32f7/hal_clock.c
  src/hal/stm32f7/hal_gpio.c
  src/hal/stm32f7/hal_spi.c
  src/hal/stm32f7/sd_spi_hw.c
  src/hal/stm32f7/hal_adc.c
  src/hal/stm32f7/hal_uart.c
  src/hal/stm32f7/hal_tim_dma.c
  src/hal/stm32f7/hal_tim_ic.c
  src/hal/stm32f7/hal_exti.c
  src/hal/stm32f7/hal_usb_cdc.c
  src/hal/stm32f7/hal_flash.c
  src/hal/stm32f7/hal_bootloader.c
  src/hal/stm32f7/startup_stm32f722.c
)
