# USB startup failure propagation

This is shared USB-stack correctness work for the F405 bring-up and existing F7 code. It is not a board image, PHY qualification or enumeration test. F4 hardware selectors remain disabled.

## Problems found

The existing TX/RX FIFO flush helpers stopped polling after a finite count but returned no status. `dwc2_core_init` could therefore report success while the flush bit remained set. Separately, device-stack initialization assigned its initialized-port marker before attempting controller startup. When that attempt failed, a later call could see the marker and return success without retrying the controller.

## Changes and policy

- FIFO helpers return true only after observing the relevant flush bit clear within their polling budget. The default remains one million register reads. The loop has no post-decrement underflow or extra read beyond the budget; invalid budget overrides fail compilation.
- Core initialization requires TX success before attempting RX and requires both before proceeding with its final interrupt setup. Failures propagate through the existing DCD and device-stack calls.
- A failed device-controller start clears the initialized-port marker and latches an unrecovered failed state. Further initialization and deinitialization calls return false until a cold software restart clears static state. They do not claim cleanup or retry over partially initialized classes/queues/PHY.
- Both explicit and configured legacy device initialization entry points clear the active device-role marker on failure. Host-role handling is unchanged.

This intentionally tightens shared **startup-failure** behavior, including F7. The healthy initialization/deinitialization path is unchanged by inspection; the tests below do not emulate a complete successful device session. Earlier allocation/class-setup failures are outside the new DCD-failure latch. Existing runtime endpoint/bus-reset flush callers still ignore the newly available result; comprehensive runtime fault recovery is not claimed.

## Bounded verification

The tests compile and execute the real TinyUSB stack alongside the F405 startup/time components. A small register-readiness model supplies a synthetic valid core ID, ready/reset/flush flags and a few core registers. It is not a USB packet emulator and none of its register values were read from Robert's board.

Four new test groups cover default/invalid budgets, TX/RX first/final/late/stalled completion, successful common-core initialization requiring both flushes, and TX/RX failure propagation through core, DCD, device stack and both public initialization styles. The legacy API is explicitly enabled in the test build. Six inherited link groups preserve existing identity/vector/time checks.

The fast readiness cases use an eight-read test override. A separate compile check verifies the unchanged production ceiling of one million. Failed paths must not reach device-control/connect register access, NVIC enabling or final interrupt-mask setup. Initialized/role markers remain invalid; retries and deinit remain false without further controller access.

## Boundaries before hardware

Finite polling work is not a measured wall-clock timeout. PHY power and other partial state can remain after a failed attempt. Returning false, clearing software markers and avoiding the explicit connect call do not prove electrical disconnection, rollback, motor shutdown or a recovery path.

Next controller work remains PHY/mode settling, disconnect/connect sequencing and useful diagnostics. The MLTEMPF4 board identification supplied by Robert is consistent with the intended F405/168 MHz/MPU6000 path, but physical revision, VBUS routing and independent recovery are still unverified. PA9 must not be assumed available for sensing merely from generic F405 code. No arming/failsafe, NVM schema or flight-readiness change is made here.
