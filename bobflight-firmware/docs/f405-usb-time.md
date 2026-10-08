# F405 owned USB timing service

This moves TinyUSB timing callbacks out of the link-test fixture into `src/hal/stm32f4/usb_time.c`, using the existing DWT/SysTick timebase. It supplies a bounded delay primitive for the upcoming USB PHY/controller sequence. It does not initialize the controller or enable an F4 hardware target.

## Binding and ownership

Bind once after successful clock/time startup, in reset-time Thread mode with interrupts masked. The supplied plan must report the current canonical 168 MHz HCLK/SYSCLK and 48 MHz USB rate. A healthy timebase snapshot is required. On success the service assigns SystemCoreClock; failed binding does not alter it, and later successful re-binding/resetting time is not allowed.

The timebase must have been initialized with that same actual HCLK. Supplied rates and a healthy snapshot do not independently measure or prove calibration, oscillator frequency, GPIO preparation or board wiring. Bind with exclusive initialization ownership before any USB callbacks execute. Complete the [USB platform preparation](f405-usb-prepare.md) before actual controller use. The test fixture's board-prepared boolean is still not verification.

## Finite waits and fault boundary

`bf_f405_usb_wait_us` accepts Thread-mode requests up to 100,000 microseconds with a budget of 1..1,000,000 timebase reads after the initial snapshot. It returns true only when the measured duration has elapsed; zero duration requires a healthy snapshot. Bad parameters/context, unavailable time or exhausted work budget return false. Incoming PRIMASK is preserved. There is no counter reset, fallback timing estimate or automatic retry.

A read budget bounds polling work, not wall-clock time, scheduling latency or guaranteed delay completion. A false result is not an elapsed delay. The caller must treat it as failure rather than continue a PHY transition blindly. The inherited timebase limitations still apply, including no missed full raw-counter wraps or independent detection of analog clock loss.

TinyUSB's millisecond callback uses the same timebase and never invents zero on failure. Its delay callback accepts up to 100 ms and invokes the bounded wait. An unavailable ticker (reason 1), oversized millisecond request (reason 2), or failed delay (reason 3) invokes the overridable nonreturning fault hook. The default records the reason, masks interrupts and stops. This is an explicit unrecovered diagnostic fault, not USB disconnect, recovery or watchdog handling. The default is for unqualified bring-up only: it does not shut down motor peripherals and is not an armed-system failsafe. Real controller integration must decide and qualify its system-wide fault/recovery behavior before any F4 motor capability is enabled.

## Software verification

Five new ARM-execution groups cover binding/clock/context checks, delay progress and raw-counter rollover, both interrupt-mask states, finite stalled-counter work, invalid budgets/requests, and the actual default fault loop and reason. Six inherited link checks revalidate the real TinyUSB linkage, USB identities, vectors and ticker callback. The preparation suite also uses the promoted service. USB controller space remains unmapped in these checks; no controller/packet simulation is added.

The F4 CI toolchain-install step now has a five-minute timeout, following an observed installation stall that was resolved by a single job restart. This limits infrastructure waiting without skipping any firmware tests.

Next: use this timing service for PHY/mode settling and disconnect/reconnect transitions, then integrate CDC diagnostics. Physical USB enumeration, real clock accuracy and target recovery still need an exact F405 board. No arming/failsafe, persistent-settings schema or flight-ready change is made here.

The next [USB startup failure correction](usb-startup-failure.md) propagates stalled FIFO flushes and prevents false initialized states before controller bring-up proceeds.
