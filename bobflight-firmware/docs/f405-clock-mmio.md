# F405xG reset-to-clock register adapter

This component connects the existing reset/vector/memory initializer and clock sequencer through real, fixed-address volatile accesses in a linked ARM fixture. It is **not** an enabled board backend or flashable target. No routing profile, driver capability, arming/failsafe rule, saved-settings schema or existing F7 runtime is changed.

## Contract

`bf_f405_clock_mmio_start(hse_hz, vdd_mv, poll_budget, out)` accepts explicit board-supplied clock inputs; it has no board oscillator/supply default. It first validates inputs, requires PRIMASK masking and calls the existing F405 cold-start sequence. Successful return includes DSB/ISB synchronization and leaves interrupts masked. Failure preserves caller output; callers must stop rather than initialize consumers from requested frequencies. The wrapper does not restore HSI or provide automatic recovery. The fixture routes success/failure to separate terminal stages.

This is cold-reset-only, with exclusive ownership of clock controls and no active consumers. PRIMASK does not mask NMI/HardFault, stop other bus masters or prove ownership. Compile guards accept only ARM Thumb with `BF_F4_COMPONENT_F405XG`, reject missing/conflicting F411 definitions, and do not detect the physical chip or density. There is no F411 direct adapter in this slice.

Callbacks reject non-NULL contexts, invalid enum identifiers, NULL read outputs and CSR writes before any volatile access. Only aligned 32-bit accesses to the following registers are available; callers cannot inject addresses. CSR is read-only **in this adapter**, despite some hardware bits being writable. Callback success means an access was issued, not bus-fault containment or readback validation. A physical bus fault can trap rather than return an error status.

| Register | Address |
|---|---|
| RCC_CR | `0x40023800` |
| RCC_PLLCFGR | `0x40023804` |
| RCC_CFGR | `0x40023808` |
| RCC_APB1ENR | `0x40023840` |
| PWR_CR | `0x40007000` |
| PWR_CSR | `0x40007004` |
| FLASH_ACR | `0x40023C00` |

Addresses were independently evaluated from the ST base macros and `offsetof` of RCC/PWR/FLASH structs in [stm32f405xx.h at 9192c7b9df75a142f2027ab266601fe061fc00b3](https://github.com/STMicroelectronics/cmsis-device-f4/blob/9192c7b9df75a142f2027ab266601fe061fc00b3/Include/stm32f405xx.h). Header SHA256: `10c3b2dfc2b358d62a55668a7085ef07c44fc01abca8f2a08c2640a538040c7b`. No ST driver implementation is imported.

## What is exercised

`tests/test_f405_clock_mmio.py` links the real startup, planner, sequencer and MMIO adapter with a deliberately minimal test entry. Cortex-M4 Unicorn execution starts at the reset vector, establishes FPU/VTOR and C storage, executes the clock sequence through actual volatile loads/stores, and stops at a successful or failed next stage within 60,000 instructions.

Seven groups cover nominal and delayed readiness with 8/25 MHz simulation crystals, all modeled readiness timeouts, rejected flash/SYSCLK writes, unsafe initial clocks, invalid inputs, the PRIMASK guard, callback allowlist rejection and compile-time part guards. Tests check exact register-write order, power-interface gating, PLL-off reprogramming, flash latency/readiness before switching, preserved output on failure, preserved noinit/DMA storage, and final frequency descriptors. The poll budget counts register reads, not elapsed milliseconds.

The model implements read-only readiness/status bits and bounded readiness delays. It is not an analog oscillator, regulator, bus-latency, clock-frequency or errata model. Reported clock frequencies are derived from the supplied nominal HSE value, not measurements. On failures, preserved descriptors are not usable measurements or fallback clocks.

Linking the previously compile-only clock planner revealed its compiler-generated `memset`/`memcpy` dependencies. The fixture explicitly links the ARM toolchain's C library and compiler support (`-lc`, `-lgcc`) while retaining `-nostdlib` startup control. Only non-runtime debug information is stripped; symbols remain available and unexpected allocated sections remain errors. It does not use a mock memory helper or silently relax the linker bounds.

The dedicated F4 CI job always runs this suite. Native CTest adds it when ARM GCC and the pinned existing model dependencies are installed, alongside the reset-only suite. Test ELF files are temporary, never published as firmware artifacts.

## Next integration gates

Monotonic timekeeping, scheduler timing, USB/CDC, board-driven GPIO/SPI/sensors/UART, persistence and guarded `bl`, plus timers/DMA/ADC remain prerequisites for usable board support. F411's separate electrical timer-limit question remains open. Broader routing work follows [traceable board references](../../TARGETS.md#referencing-upstream-routing-facts), with independently authored mappings and per-variant verification.

No firmware rebuild or physical installation is requested. Do not flash a fixture ELF. Independently verified BOOT/SWD recovery is required before future experimental installation; software `bl` cannot recover failed startup or unavailable USB. See [the overall gates](broader-mcu-support.md).
