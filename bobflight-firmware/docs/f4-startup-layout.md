# Exact-density F4 startup and memory components

This adds original reset/vector code and linker layouts for **STM32F405xG** and **STM32F411xE**, tested as isolated ELF fixtures. It does not produce a supported board image. The registry and backend selector remain unchanged. No startup source, linker or new toolchain is added to an existing hardware build.

## Density and memory contract

| Component | Physical flash | Application window | Future settings sectors | Normal SRAM | CPU-only CCM |
|---|---|---|---|---|---|
| F405xG | 1 MiB, end-exclusive `0x08100000` | `0x08000000..0x080C0000` (768 KiB) | sectors 10/11, `0x080C0000` / `0x080E0000`, 128 KiB each | 112 KiB SRAM1 plus contiguous 16 KiB SRAM2 | 64 KiB at `0x10000000` |
| F411xE | 512 KiB, end-exclusive `0x08080000` | `0x08000000..0x08040000` (256 KiB) | sectors 6/7, `0x08040000` / `0x08060000`, 128 KiB each | 128 KiB at `0x20000000` | none |

Ranges above are start-inclusive/end-exclusive. These layouts do not cover other flash densities or qualify PCB/package pin mappings. Reserving two sectors is a layout prerequisite for future redundant nonvolatile settings, **not** a persistence implementation, schema change, or working `save` command on F4.

Both parts use the top of normal SRAM (`0x20020000`, 8-byte aligned) as initial MSP. The linker reserves 1 KiB heap space and rejects layouts leaving less than 8 KiB stack headroom. This is a static space guard, not measured worst-case stack usage or runtime overflow protection. Application load segments cannot occupy settings sectors. Unexpected allocated sections and dynamic/legacy ARM stubs are rejected, not silently placed.

`.data` is copied from its flash LMA; `.bss` and 32-byte-aligned `.dma_bss` are zeroed. `.noinit` remains untouched. F405's optional `.ccm_noinit` is deliberately **uninitialized CPU-only scratch**, not initialized data/BSS and never DMA memory. Code must establish CCM access and initialize scratch before reading it. F411 rejects any nonempty CCM allocation. No automatic initialized/zeroed CCM section is supplied.

## Reset and vectors

The naked assembly entry masks normal interrupts, enables CP10/CP11 with DSB/ISB before entering compiled C, sets VTOR to the retained 512-byte-aligned table, then branches to the memory initializer. Only integer operations run before FPU enable. Normal interrupts remain masked when the external `bf_f4_component_entry` is reached; the future HAL owns enabling them after real initialization. If the component entry returns, execution halts in the default-handler path. No clock, timer, USB, GPIO or motor initialization is performed.

The vector table contains 98 words for F405 (IRQs 0..81) and 102 for F411 (IRQs 0..85). Reserved core and peripheral slots are zero. Named handlers are weak defaults that loop without touching pins; strong application handlers can override them. Tests override every supported core/peripheral handler with distinguishable code to verify the actual linked wiring, rather than comparing indistinguishable default-handler addresses.

Exactly one component-part definition is required. A linker part-ID assertion and exact vector-size check reject mismatched startup/linker pairs. These components assume a real reset-time environment, not a jump from arbitrary running firmware. They do not clear all inherited peripheral/NVIC state or implement ROM-bootloader handoff.

## Evidence and provenance

Memory constants and IRQ-number facts were checked against ST CMSIS headers at commit `9192c7b9df75a142f2027ab266601fe061fc00b3`:

- [STM32F405 header](https://github.com/STMicroelectronics/cmsis-device-f4/blob/9192c7b9df75a142f2027ab266601fe061fc00b3/Include/stm32f405xx.h), including SRAM1/SRAM2/CCM regions and flash end.
- [STM32F411xE header](https://github.com/STMicroelectronics/cmsis-device-f4/blob/9192c7b9df75a142f2027ab266601fe061fc00b3/Include/stm32f411xe.h), including 128 KiB SRAM, flash end and sparse IRQ slots.
- [ST STM324xG flash-sector example](https://github.com/STMicroelectronics/STM32CubeF4/blob/master/Projects/STM324xG_EVAL/Examples/FLASH/FLASH_EraseProgram/Inc/main.h) for the 1 MiB F4 sector map. This family example corroborates the map; it is not proof of a BobFlight board port.
- [ST STM32F411E flash-sector example](https://github.com/STMicroelectronics/STM32CubeF4/blob/master/Projects/STM32F411E-Discovery/Examples/FLASH/FLASH_EraseProgram/Inc/main.h) for the eight-sector F411xE map.

`tests/fixtures/f4_startup/irq_facts.json` freezes the observed IRQ facts for offline testing. No vendor startup/driver implementation is imported. The retrieved byte fingerprints identify the reviewed copies, not claims that every applicable erratum has been resolved:

- `stm32f405xx.h`: `10c3b2dfc2b358d62a55668a7085ef07c44fc01abca8f2a08c2640a538040c7b`
- `stm32f411xe.h`: `37eb4283db7ea17197e6e2b4a855e87fb639c9ca8eaf4777aa389a096235013d`
- `f4-flash-main.h`: `aaa936b24084b53bac9bca8d43274ff998d86d4fe09d850438da5e2b93ffcca0`
- `f411-flash-main.h`: `79a3a442867006ef89b47801e9cfaca09fc01cbe2123e1d1b48ddc73b9896f1b`

## Verification and CI

`tests/test_f4_startup_layout.py` runs seven test groups with per-part subcases: positive/strong-override vector links, bounded reset execution, compile/link part guards, flash/RAM/stack overflow, CCM and DMA placement, orphan-section rejection, and compiler-library unwind records explicitly bounded in application flash. Commands compile with strict warnings, `-ffreestanding`, `-fno-builtin`, Cortex-M4 hard-float flags and `-nostdlib`. The linker rejects orphan sections. Generated ELFs are temporary component fixtures, not uploaded firmware artifacts.

The reset model loads only physical flash contents into Unicorn, pre-fills SRAM/CCM with sentinel bytes, and executes at most 20,000 instructions. It checks data copy, BSS/DMA clearing, noinit/CCM preservation, CPACR and VTOR writes, retained interrupt masking and arrival at the component entry. Unexpected reset writes outside normal SRAM and those two system registers fail the model. Emulation is not silicon validation.

The dedicated ARM-component CI job installs pinned test dependencies and always runs these checks. Native CTest also includes them when ARM GCC and the test dependencies are available; normal host builds without them report the omission explicitly, while dedicated CI remains mandatory.

## Remaining gates

The original reset-only fixture remains focused on memory/vector behavior. A separate [F405 reset-to-MMIO fixture](f405-clock-mmio.md) now links this startup with clock sequencing and an exact-address adapter. It is model-tested, not a hardware backend. Physical silicon and errata qualification, monotonic timing, USB/peripheral drivers, nonvolatile storage and physical guarded `bl` verification remain unfinished. F411 has no direct adapter in this slice, and its timer electrical-limit question still applies before timer enablement.

No arming/failsafe, flight-ready status, existing firmware runtime or saved-configuration behavior changes. No physical board was flashed or tested. No user rebuild/installation is requested. Do not use these fixture ELFs on hardware; experimental installation still requires a separately verified BOOT/SWD recovery route. See [broader support gates](broader-mcu-support.md).
