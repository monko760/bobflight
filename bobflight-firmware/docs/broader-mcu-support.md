# Broader MCU support: implementation gates

Shared exact-part MCU backends and board definitions remain the architecture. A registry entry is not hardware support, and a compilable component is not a usable board image.

## Current slice

PR #71 provides F405/F411 clock arithmetic and register plans. Its follow-up adds ordered cold-start clock execution through injected register callbacks, with bounded polling and explicit failure classification. Host models and Cortex-M4 object compilation do not establish physical startup. Hardware selectors remain unchanged and reject unimplemented parts.

The follow-up is stacked on #71, not a silent merge of that draft. PR #72's configurator improvements are independently merged; no configurator changes belong to this clock slice.

## Next implementation gates

1. Exact-part reset/vector tables and memory layout, CPU/FPU flags, stack and DMA-capable RAM placement, then a verified physical register-access adapter. Establish reset-state and fault behavior before connecting clock startup to a hardware build.
2. Monotonic timebase and scheduler timing, USB/CDC with a validated 48 MHz source, GPIO/SPI/sensor drivers and UART/receiver freshness. Preserve existing timing and failsafe contracts.
3. Part/density-specific flash geometry and reserved nonvolatile settings storage, power-loss-safe Save, `diff all`, guarded software bootloader entry and independent recovery. Do not infer ROM addresses or flash layout from another part.
4. ADC, timers/DMA/interrupt resources and motor protocols. F405 is the initial hardware-integration path. F411's unresolved APB1 timer electrical-limit note must be resolved before enabling its hardware timers, not treated as approval because the clock formula compiles.
5. Exact-board/package/revision mappings, crystal/supply assumptions, sensor identity/orientation and pin/resource verification. Validate USB, sensors, timing, saved settings and `bl` on each board before calling its profile usable.

Additional F7 variants and H7 require their own clock, memory/cache/DMA and peripheral implementations under the same contracts. They do not inherit compatibility merely from a family label. No new work is planned for the excluded legacy board.

## Stop conditions

Clock-start callbacks require exclusive control over clock registers during reset-time bring-up, with consumers/peripherals not yet initialized and no concurrent interrupt/other writer changing clock controls. Initial register checks are not a general proof of a complete reset state. Never use this routine for live frequency reconfiguration.

On any startup error, do not initialize clock-dependent peripherals from the requested frequencies. The unchanged output is not a measurement of current clocks. A false post-switch classifier is not proof of HSI or a safe fallback. No rollback, system reset or recovery is promised by this component.

F4/H7 entries remain planned and unavailable for hardware images. No arming/failsafe policy, motor capability, NVM schema or flight-ready status changes here. No user firmware rebuild or hardware flash is requested. Software `bl` requires running firmware; independent BOOT/SWD recovery remains necessary before experimental installation.

See [clock evidence and the F411 constraint](f4-clock-plans.md) and [clock-start API and failure handling](f4-clock-start.md).
