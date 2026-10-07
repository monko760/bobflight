# F405 USB platform preparation

The next [USB integration](f405-usb-link.md) stage executes RCC, GPIO and NVIC preparation after the real reset/clock/time prefix. This is shared F405xG peripheral code, not a board profile or working USB image. F4 hardware selectors remain disabled.

## Explicit contracts

`bf_f405_usb_prepare` requires a successful canonical F405 clock result, verified board HSE/supply and ownership of USB, PA11/PA12 and any requested PA9 sense pin. Only reset-time Thread mode with interrupts masked is accepted. It checks timebase health and compares live RCC readiness/source/prescaler/PLL fields with the supplied 168 MHz HCLK / 48 MHz USB plan. Register agreement is not a physical frequency measurement, chip/package probe or verification of board wiring.

The caller must explicitly choose one of two policies; zero is invalid:

- **USB-bus-powered:** leave PA9 entirely untouched. This policy is appropriate only when the actual board's power/wiring makes software VBUS validity correct.
- **PA9 VBUS sense:** prepare PA9 as input with no pull. The board must actually route VBUS to that pin appropriately.

This stage does not program USB GCCFG or choose a default policy. Future controller initialization must use the same policy. A boolean supplied to a test fixture is not board qualification.

## Preparation sequence

Reject active USB clock/reset ownership or an enabled USB IRQ before any configuration write. Enable GPIOA, preserve unrelated pins while assigning PA11/12 AF10, push-pull, high speed and no pulls; configure MODER after the other pin fields. Only the explicit PA9 policy changes PA9's mode/pull fields. Enable OTG_FS clock and pulse its RCC reset with readback/barriers. Disable/clear IRQ 67 and configure priority 5, leaving the IRQ disabled and global PRIMASK unchanged.

Configuration fields are read back. One hardware-write attempt is allowed per reset, including a failed attempt. Failures have explicit status codes. Changes to GPIO/clocks can remain after failure: no rollback, bus-fault containment or safe-controller-state guarantee is claimed. Do not continue to TinyUSB initialization on failure.

There are **no USB core/PHY register accesses**, no F7 PLLSAI/DCKCFGR2 writes, no interrupt enable, motor/arming/failsafe change, persistent-settings change or board installation artifact.

## Verification and evidence

The actual module is linked alongside real TinyUSB and the existing F405 reset/clock/time code. Six new ARM-model groups check both VBUS policies, unrelated-pin preservation, invalid input/context, live clock mismatch, existing ownership, timing failure, write-readback failures with retry latching and part guards. Six inherited USB-link groups recheck identities, vectors, IRQ writes and time callbacks. A seventh new check preprocesses the actual TinyUSB F405/F7 controller initialization branches to verify the reserved-register-write exclusion; it does not execute the controller. Only RCC/GPIO/NVIC registers are modeled; USB controller space is unmapped, so crossing that boundary fails instead of simulating enumeration.

RCC/GPIO addresses were independently verified using compiled struct offsets from ST's [`stm32f405xx.h`](https://github.com/STMicroelectronics/cmsis-device-f4/blob/9192c7b9df75a142f2027ab266601fe061fc00b3/Include/stm32f405xx.h). SHA256: `10c3b2dfc2b358d62a55668a7085ef07c44fc01abca8f2a08c2640a538040c7b`. Source is used as hardware-register evidence; no vendor driver implementation is copied.

## Remaining USB boundary

PHY power, mode settling/readback, soft disconnect/connect, DWC2 initialization and host enumeration remain separate work. In particular, F405's `NOVBUSSENS` and F7's `VBDEN` have different meanings. The existing TinyUSB initialization wrote later-core GOTGCTL session-override bits that are reserved in the older F405 layout. A narrow local conditional now omits those writes only for the F405 component, leaving other targets on their previous path. F405 uses the existing GCCFG sensing path instead. This removes a register-layout mismatch; it does not qualify actual controller startup or enumeration.

A physical F405 will resolve actual oscillator/VBUS routing, reset/attachment behavior and host enumeration faster than a growing controller simulation. Software preparation can progress while the board is sourced; experimental flashing still requires an exact profile and independent BOOT/SWD recovery.
