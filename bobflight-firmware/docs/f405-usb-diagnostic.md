# MLTEMPF4 USB diagnostic candidate

This standalone, experimental F405xG image integrates the existing reset, clock, time, USB preparation and real TinyUSB CDC stack. It is not the normal BobFlight firmware or a new permanent flight/bench profile. General F4 target selectors remain disabled.

## Intended first test

A bare Motolab Tempest F4, powered only from USB, with independently accessible BOOT pads. The first hardware test is enumeration followed by the read-only `help`, `version` and `status` commands in a serial terminal with DTR asserted. Full configurator compatibility, sensors, motors, settings and `bl` are not implemented in this image.

The current hardware owner has confirmed ROM DFU enumeration using the BOOT pads. Firmware restoration through DFU is not yet demonstrated. Existing settings on that bare board are disposable; no backup is required for that particular test. Other users should preserve any firmware/settings they want to restore before installation.

## Assumptions and limits

- MLTEMPF4 reference assumptions: STM32F405xG, 8 MHz crystal, 3.3 V, nominal 168 MHz HCLK and 48 MHz USB clock.
- Runtime checks require device-ID family 0x413 and 1024 KiB flash. That ID is shared with related parts and is not an exact MCU/board identification.
- USB-only power policy deliberately leaves PA9 untouched. The matching board reference allocates PA9 to UART1 TX. This does not prove physical routing on every revision or qualify battery/external-power operation.
- PA11/12 are configured for USB. No motor, sensor or flash erase/programming drivers are linked. Installation itself replaces firmware and may erase settings.
- Startup requires cold reset. After any eventual DFU programming, unplug USB, remove the BOOT bridge, then reconnect USB. Do not rely on a direct ROM-to-application jump to supply cold-reset peripheral state.
- RAM stage/error fields are available to a debugger when USB startup fails. BOOT pads alone do not expose these fields.

## Startup sequencing and console

Interrupts remain masked until clock/time/preparation/binding and TinyUSB initialization succeed. The application then explicitly unmasks interrupts and runs the nonblocking CDC task loop. It retains partially transmitted replies and rejects overlong/control-containing commands as complete invalid lines, rather than executing truncated prefixes.

F405-only changes wait one measured microsecond after core reset, force and verify device mode before accessing the device-register bank, and hold software disconnect before connection. The 50 ms mode-settle and 20 ms disconnect waits are conservative bring-up choices, not claimed vendor-mandated minima or proof of host behavior. F7 retains its existing sequence.

The [ST driver reference](https://github.com/STMicroelectronics/stm32f4xx-hal-driver/blob/6122597c53e7b7dad7bbda0e56beaab851dab9f3/Src/stm32f4xx_ll_usb.c) checks mode in 10 ms polling increments. An earlier review's claimed mandatory 25 ms delay was not accepted. The inherited TinyUSB core-reset comment documents waiting at least three PHY clocks after reset; the one-microsecond wait is a margin for the configured clock.

## Build only

Requires Python 3 and ARM GCC/objcopy on PATH. From `bobflight-firmware` at the reviewed diagnostic revision:

```powershell
python .\tools\build_f405_usb_diagnostic.py --out .\build-f405-usb-diagnostic
if ($LASTEXITCODE -ne 0) { throw "Diagnostic build failed" }
```

The output is `bobflight-mltempf4-usb-diagnostic.hex` with companion ELF/BIN files. The build script has no flash/erase operation. Fetch the pinned diagnostic commit rather than assuming the normal main branch contains this standalone tool.

## Verification and first-hardware boundaries

151 local CTest targets passed for the integrated candidate, including the image/parser check; the F745 cross-build also passed. Twelve controller/link groups exercise actual compiled stack code against a small synthetic register-readiness model. They check failure propagation, device-mode failure, measured-delay failure, ordered disconnect/configure/connect and software initialization. The positive model explicitly remains unmounted because no host or USB packets are emulated.

Image checks cover vector binding, linker bounds, absence of heap/stdio dependencies, diagnostic USB identity and placement of IRQ unmasking after stack initialization. Native parser tests reject write commands, control bytes and overlong lines. These do not establish physical enumeration, interrupt delivery, clock accuracy, sustained traffic reliability or flight readiness.

After hardware enumeration, expected results are a CDC serial port, a diagnostic banner, `version` identifying the F405 test image, and `status` reporting stage 8/error 0 with increasing uptime. If it never enumerates, reports an error, resets repeatedly or heats unexpectedly, disconnect USB and use the confirmed BOOT route for recovery. Do not connect motors or external power to extend this first test.
