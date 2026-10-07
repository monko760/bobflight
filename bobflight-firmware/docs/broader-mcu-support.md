# Broader MCU support: implementation gates

Shared exact-part MCU backends and board definitions remain the architecture. A registry entry is not hardware support, and a compilable component is not a usable board image.

## Current slice

Clock/register plans, callback-driven cold-start sequencing, and exact-density reset/vector/linker components are merged foundations. The [F405xG direct register adapter](f405-clock-mmio.md) now connects reset through clock startup in an executable, bounded register-model fixture. The [F405 timebase](f405-timebase.md) extends this modeled path through DWT/SysTick using the same cycle accumulator as existing F7. F411 retains isolated component coverage, without these physical-address adapters.

This is still not a usable board image: models supply readiness signals, and no silicon was exercised. Hardware selectors remain unchanged and reject unimplemented parts. Board routing facts will follow the [traceable upstream-reference process](../../TARGETS.md#referencing-upstream-routing-facts), without importing GPL implementation or assuming driver compatibility.

## Next implementation gates

1. Extend the linked F405 reset/clock path into a complete hardware backend only after applicable silicon/errata and reset/fault qualification. The new adapter is verified by address checks and modeled execution, not physical operation. Preserve exact-density layouts and the failure stop boundary.
2. Qualify the modeled F405 DWT/SysTick timebase on hardware and integrate scheduler/interrupt delivery. Add USB/CDC with a validated 48 MHz source, GPIO/SPI/sensor drivers and UART/receiver freshness. Preserve existing timing and failsafe contracts.
3. Part/density-specific flash geometry and reserved nonvolatile settings storage, power-loss-safe Save, `diff all`, guarded software bootloader entry and independent recovery. Do not infer ROM addresses or flash layout from another part.
4. ADC, timers/DMA/interrupt resources and motor protocols. F405 is the initial hardware-integration path. F411's unresolved APB1 timer electrical-limit note must be resolved before enabling its hardware timers, not treated as approval because the clock formula compiles.
5. Exact-board/package/revision mappings, crystal/supply assumptions, sensor identity/orientation and pin/resource verification. Validate USB, sensors, timing, saved settings and `bl` on each board before calling its profile usable.

Additional F7 variants and H7 require their own clock, memory/cache/DMA and peripheral implementations under the same contracts. They do not inherit compatibility merely from a family label. No new work is planned for the excluded legacy board.

## Stop conditions

Clock-start callbacks require exclusive control over clock registers during reset-time bring-up, with consumers/peripherals not yet initialized and no concurrent interrupt/other writer changing clock controls. Initial register checks are not a general proof of a complete reset state. Never use this routine for live frequency reconfiguration.

On any startup error, do not initialize clock-dependent peripherals from the requested frequencies. The unchanged output is not a measurement of current clocks. A false post-switch classifier is not proof of HSI or a safe fallback. No rollback, system reset or recovery is promised by this component.

F4/H7 entries remain planned and unavailable for hardware images. No arming/failsafe policy, motor capability, NVM schema or flight-ready status changes here. No user firmware rebuild or hardware flash is requested. Software `bl` requires running firmware; independent BOOT/SWD recovery remains necessary before experimental installation.

See [clock evidence and the F411 constraint](f4-clock-plans.md) and [clock-start API and failure handling](f4-clock-start.md).
