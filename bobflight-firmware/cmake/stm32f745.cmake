# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
#
# Toolchain stub for arm-none-eabi targeting STM32F745.
# Usage:
#   cmake -S . -B build-f745-kakute \
#     -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
#     -DBOBFLIGHT_HOST_SMOKE=OFF \
#     -DBOBFLIGHT_BOARD=kakute_f7_hdv
#
# Same Cortex-M7 flags as F722. Requires arm-none-eabi-gcc on PATH.
# CMSIS/device pack is NOT vendored. Owned startup + nosys.specs + F745 ld
# produce a skeleton .elf/.hex. Pins come only from owned IR (never invent).

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)

set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(CMAKE_CXX_COMPILER arm-none-eabi-g++)
set(CMAKE_ASM_COMPILER arm-none-eabi-gcc)
set(CMAKE_OBJCOPY arm-none-eabi-objcopy)
set(CMAKE_SIZE arm-none-eabi-size)

set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

set(MCU_FLAGS "-mcpu=cortex-m7 -mthumb -mfpu=fpv5-sp-d16 -mfloat-abi=hard")
set(CMAKE_C_FLAGS_INIT "${MCU_FLAGS} -ffunction-sections -fdata-sections")
set(LINKER_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/stm32f745.ld")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${MCU_FLAGS} -Wl,--gc-sections")

set(BOBFLIGHT_TARGET_MCU "STM32F745" CACHE STRING "MCU family")
