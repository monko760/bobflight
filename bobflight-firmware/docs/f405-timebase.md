# F405xG DWT/SysTick timekeeping component

An isolated component links [reset and clocks](f405-clock-mmio.md) through a DWT cycle-counter timebase in an executable ARM test fixture. It is **not** an enabled F4 backend, scheduler integration or board image. Existing F7 timekeeping and the shared `hal/cycle_clock.h` implementation are unchanged.

## Initialization and ownership

`bf_f405_time_init(core_hz)` requires established, stable HCLK (whole MHz in 1..168 MHz), Thread mode, PRIMASK=1, inactive/nonpending SysTick and exclusive DWT/SysTick ownership. A supplied frequency is metadata, not an oscillator measurement. Runtime clock changes are unsupported. Invalid inputs/context are rejected before MMIO; existing SysTick enable/interrupt or pending state is rejected before writes.

A valid hardware attempt is one-shot per reset. Enable trace/cycle counting with readbacks and a bounded 64-NOP progress probe; do not reset CYCCNT or access the Cortex-M7 DWT lock register. Configure SysTick for nominal 1 kHz HCLK operation, lowest implemented F405 priority (0xf0), then verify reload/priority/control. Unrelated trace/counter/priority bits are preserved. Interrupts remain masked until a future complete backend establishes all consumers and explicitly enables them.

Failed attempts latch unavailable. After rejected SysTick configuration the component requests disabling its owned timer, but cannot promise that defective hardware accepted the cleanup write. Earlier trace/counter changes can remain. No recovery, HSI fallback or safe-clock inference is provided. PRIMASK does not exclude NMI/HardFault or prove exclusive ownership.

## Reading and maintaining time

`bf_f405_time_read_us(uint64_t *out)` returns a 64-bit microsecond snapshot. `bf_f405_time_read_ms(uint32_t *out)` derives milliseconds from that same epoch and wraps modulo 2^32, rather than running an independent tick counter. Both preserve caller output and return false when unavailable. NULL outputs and NMI/HardFault contexts are rejected. Callers own their output buffers; snapshots are taken inside the critical section.

The strong component `SysTick_Handler` extends the same cycle accumulator. Foreground/handler access saves PRIMASK, masks normal interrupts, checks readiness and folds cycles while locked, then restores the exact incoming mask. Readiness is checked **inside** that section to prevent an interrupt from invalidating it between an unlocked check and an update. A regression hook checks private state reads occur with interrupts masked.

Loss of trace enable, counter availability/enable, SysTick clock/interrupt enable or the expected reload latches unavailable. Re-enabling hardware does not silently revive the clock. No coarse-resolution fallback is introduced, and no application arming/failsafe policy is changed. A complete backend still needs to propagate this failure through the existing health contracts.

## Timing limits

The existing shared accumulator preserves fractional cycles and extends a 32-bit raw counter into microseconds. Every update must occur strictly before another full counter wrap: `2^32 / core_hz` seconds, approximately 25.565 seconds at 168 MHz. SysTick is configured to fold every millisecond, but this code does not enable interrupts or prove their delivery. Lost whole wraps during long interrupt blackouts cannot be reconstructed from CYCCNT alone. Initialization enable/progress checks and runtime register checks cannot detect every later stuck-counter fault.

No elapsed-wall-time guarantee applies during debugger halts, sleep, analog clock loss or runtime frequency changes. The model is not a frequency measurement or performance benchmark. No general-purpose timer/DMA resource is consumed by this component.

## Register evidence

Addresses and bit positions were independently checked against ARM CMSIS 5.9.0 [core_cm4.h](https://github.com/ARM-software/CMSIS_5/blob/5.9.0/CMSIS/Core/Include/core_cm4.h), including compiled `offsetof` checks of the DWT/CoreDebug/SysTick/SCB structs. SHA256: `f5b63d52dd1557b15ca414cb59c264f595a7b5669db2a5878dffe22f4caedc8c`.

| Register | Address |
|---|---|
| DWT_CTRL / CYCCNT | `0xE0001000` / `0xE0001004` |
| CoreDebug DEMCR | `0xE000EDFC` |
| SysTick CTRL / LOAD / VAL | `0xE000E010` / `0xE000E014` / `0xE000E018` |
| SCB ICSR / SHPR3 | `0xE000ED04` / `0xE000ED20` |

The 0xf0 priority uses STM32F405's four implemented priority bits. Compile-time F405xG/Thumb guards are not physical chip/density identification.

## Verification

`tests/test_f405_timebase.py` compiles and links the real reset, clock, MMIO and time code with the exact-density layout. Eight groups cover successful reset-to-time setup, fractions and repeated raw-counter wraps, a synthetic large-epoch millisecond boundary, rejected input/context/ownership, initialization failures, latched runtime health loss from foreground/handler, null/nonmaskable/reinit guards and compile guards. Both prior PRIMASK states are exercised. A failed clock start must never initialize timekeeping.

The millisecond-boundary test seeds the private accumulated epoch to avoid billions of artificial ticks; cycle accumulation is separately tested with explicit counter traces and the existing host suite. SysTick vector binding and actual handler instructions are checked, but handler calls are explicitly injected by the harness: NVIC delivery, real interrupt latency, nesting and physical timing are not qualified. Test execution has finite instruction budgets.

The ARM-component CI job runs this alongside reset/layout and reset-to-MMIO suites. Native CTest includes it when the same optional local dependencies are installed. Temporary ELF fixtures are never firmware artifacts. Hardware selectors, board definitions, saved settings and configurator remain unchanged. No user rebuild, flash or flight readiness is requested or claimed.

Next is USB/CDC integration plus physical timing/interrupt qualification before enabling a complete board backend. Routing expansion continues through [traceable upstream board facts](../../TARGETS.md#referencing-upstream-routing-facts), not inherited driver compatibility.
