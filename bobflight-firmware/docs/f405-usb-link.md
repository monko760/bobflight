# F405 TinyUSB link integration

This is a **compile/link and descriptor-execution milestone**, not a working USB board image. It links the actual vendored TinyUSB CDC/DWC2 implementation with the F405 reset, clock and timekeeping components. No mock DCD replaces the controller driver. Existing hardware selectors remain disabled for F4.

## Implemented scope

- A narrow F405-only TinyUSB device header supplies the verified OTG_FS address, endpoint count, IRQ 67 and the required interrupt enable/disable operations. It does not import Cortex-M7 cache/lock-register behavior, F7 PLLSAI setup or another board's pins.
- A full-speed, port-zero, no-OS, no-DMA CDC configuration uses existing buffer sizes. Unsupported component/port/speed combinations are rejected.
- Shared descriptors select the F405 UID at `0x1FFF7A10`, preserving F722's `0x1FF07A10` and F745's `0x1FF0F420`. Fixed-width uppercase hexadecimal conversion removes an unnecessary printf/allocator linkage dependency while preserving all 24 serial characters and their word order.
- Diagnostic callbacks connect TinyUSB's time API to the real F405 timebase. Unavailable time stops at an explicit fault boundary rather than inventing zero milliseconds. Diagnostic delays have a finite read budget and 100 ms request ceiling, not a measured wall-clock timeout.
- The real OTG_FS handler is bound into the reset vector. A fixture-only stack-start function links configuration and initialization calls behind an explicit board-prepared argument. That argument is a caller assertion, not hardware verification.

## Deliberate boundary

The reset fixture runs only through clock/time setup and then stops. **It does not call USB stack initialization.** The diagnostic image has no qualified board routing or RCC/GPIO/PHY/VBUS preparation. SystemCoreClock for the USB stack remains unset until its guarded start function is reached. None of these ELFs is an installation artifact.

Tests do not map USB peripheral registers, so accidentally crossing into controller initialization during the verified startup prefix fails rather than being mistaken for successful enumeration. No software model of USB packets, FIFO behavior or host attachment is added.

F4 and F7 give different meanings to some USB power/VBUS control bits. Do not copy the F7 setup sequence blindly. TinyUSB has revision-sensitive STM32 paths, but successful linking does not qualify those paths for the selected board. Verify the actual board oscillator, VBUS/power wiring and independent BOOT/SWD recovery before physical installation.

## Verification

`tests/test_f405_usb_link.py` links real TinyUSB, checks OTG_FS vector binding and flash bounds, and rejects allocator/printf dependencies. ARM execution checks F405/F722/F745 serial addresses, exact UTF-16 serial bytes and cached identity; it also executes the reset/clock/time prefix, TinyUSB time callback and unavailable-time fault boundary. USB initialization with an unprepared board is refused. Component and unsupported USB mode guards are tested.

The F722/F745 descriptor variants are generic-C compatibility fixtures linked to the same M4 test harness for callback execution only. They are not F7 firmware images or F7 hardware tests. Existing F7 CI builds provide the separate production regression coverage.

F405 UID/endpoint/IRQ values were checked against ST's `stm32f405xx.h` at `9192c7b9df75a142f2027ab266601fe061fc00b3`; NVIC set/clear register addresses follow the Cortex-M architecture. No vendor driver implementation or GPL board files are imported.

## Next useful milestone

The next [guarded preparation component](f405-usb-prepare.md) covers GPIO, clocks, reset and disabled IRQ setup without entering the USB controller. PHY/controller initialization and diagnostics still need integration before actual host enumeration, repeated connects/resets and timing checks on an F405. Hardware is now useful to make this phase faster, rather than expanding controller simulations. Sensor/receiver, persistent Save, guarded `bl` and motor paths remain later requirements; no arming/failsafe or flight-ready change is made here.
