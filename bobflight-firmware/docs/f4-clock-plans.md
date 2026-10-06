# F405/F411 clock-plan prototype

**Draft component, not an implemented F4 hardware backend.** The function is only linked into its native test executable. Both F4 registry entries remain planned, with no hardware toolchain, and the MCU selector still rejects them. Do not connect this prototype to register writes until the remaining device-limit review is complete.

## What is implemented

`src/hal/stm32f4/clock_plan.c` computes a proposed clock plan from an exact part, verified HSE crystal frequency and supply voltage. It has no MMIO, startup, clock switching, flash writing, timer programming or fallback path. Invalid inputs leave the output object unchanged. Voltage scale is a logical requirement, not a value to copy into PWR registers; those encodings differ by part.

| Proposed setting | STM32F405 | STM32F411 |
|---|---:|---:|
| PLL input | 1 MHz | 1 MHz |
| PLL N / P / Q | 336 / 2 / 7 | 384 / 4 / 8 |
| System / AHB | 168 MHz | 96 MHz |
| USB clock | 48 MHz | 48 MHz |
| APB1 / APB2 | 42 / 84 MHz | 48 / 96 MHz |
| APB1 / APB2 timer clocks | 84 / 168 MHz | 96 / 96 MHz |
| Proposed flash wait states | 5 | 3 |
| Required regulator scale | Scale 1 | Scale 1 |

This initial prototype accepts whole-MHz HSE crystals from 4 through 26 MHz and a supplied VDD value from 2700 through 3600 mV. It does not measure the oscillator or supply. Fractional-MHz sources, unknown parts and out-of-range values are rejected, not rounded. PLL arithmetic divides the exact HSE input before multiplying, avoiding a 32-bit overflow at higher crystal frequencies. F411 uses 96 rather than 100 MHz so the proposed main PLL also produces exact USB 48 MHz.

## Evidence and remaining review

The [official ST RCC header](https://github.com/STMicroelectronics/stm32f4xx-hal-driver/blob/master/Inc/stm32f4xx_hal_rcc.h) was read directly. Its PLLM documentation specifies divisor 2..63, VCO input 1..2 MHz, and recommends 2 MHz to limit PLL jitter. These proposed plans use the permitted 1 MHz input to provide a simple common whole-MHz plan; jitter has not been measured or qualified.

The primary [F405/F407 datasheet](https://www.st.com/resource/en/datasheet/dm00037051.pdf) and [F411 documentation](https://www.st.com/en/microcontrollers-microprocessors/stm32f411/documentation.html) remain the sources to check before hardware integration. Direct ST PDF retrieval timed out during this work. Indexed ST material confirms F405's 168 MHz maximum and the 150..168 MHz five-wait-state interval, but this is not a substitute for completing the full device review.

**Blocking before hardware integration:** verify oscillator and PLL operating limits, per-part bus ceilings, flash latency versus voltage and frequency, regulator scaling and readiness requirements, timer-clock selection assumptions, and the safe sequencing/timeouts for clock changes against the applicable device manuals and errata. No claim is made that the complete proposed operating point has passed that review. These fixed data choices can be corrected independently of the pure planning interface.

## Checks completed

- 138 accepted planning cases: two exact parts, 23 whole-MHz inputs, three supply values.
- Independent 64-bit recomputation of VCO, CPU and USB arithmetic; exact bus/timer expectations.
- Invalid frequency, voltage and part tests; null output and unchanged-output-on-failure checks.
- Warning-clean native compilation and Cortex-M4/Thumb-2/VFPv4 object compilation. An object file is not a linked or bootable firmware image.
- The new test is registered with host CTest only. Registry/backend tests continue to reject F4 hardware builds.

No current F7 firmware source list, arming/failsafe behavior, PID cadence, saved-settings schema, motor capability or flashing workflow changes. No hardware was flashed and no software bootloader entry was physically tested. No user rebuild is requested for this component.
