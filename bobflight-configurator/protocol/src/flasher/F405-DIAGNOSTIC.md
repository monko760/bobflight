# F405 diagnostic flashing and custom-board scope

The standalone USB diagnostic is separate from a normal flight-controller image. Existing F7 main-image validation remains in force. An explicit F405 diagnostic profile is required; renaming an arbitrary HEX is not a way around the gate.

## Known boards and basic custom boards

Stage 2 keeps the existing F7 board profiles and adds Motolab MLTEMPF4 as an experimental USB-only profile. Its assumptions are STM32F405xG, 1 MiB flash, an 8 MHz external crystal, 3.3 V and the internal full-speed USB connection on PA11/PA12. PA9 is not used for VBUS sensing. Use USB power only and no attached peripherals.

The custom-board form accepts hardware identity independently of a board name. Basic defaults do not assign motors, sensors, receiver, UARTs or settings storage. Currently the only custom basic image is the same F405xG/8 MHz USB diagnostic. Other MCU/density/crystal combinations are visible but blocked until a matching implementation/image exists. Selecting values validates compatibility; it does not change the contents of a prebuilt HEX. This is not universal F4/F7/H7 firmware support.

The normal firmware target registry stays unchanged: diagnostic eligibility does not promote F405 to a complete backend or mark any board flight-ready. Broader catalog recognition and complete driver support remain separate work.

## Image and device checks

The existing diagnostic HEX includes distinctive firmware strings, so the UI update is intended to accept the already-built image without a firmware rebuild. The protocol checks the explicit profile, MCU consistency, vector/entry validity, application bounds and embedded diagnostic markers. These markers are not a signature or proof of authenticity. Only use the reviewed source/build.

Before erase/program, the live path also requires the DFU alternate-zero internal-flash descriptor to match the expected 1 MiB F405xG sector geometry. A missing descriptor, a smaller density, a different layout or malformed data is an error, not permission to guess. Geometry does not identify an exact chip or board; the user must confirm the actual MCU and routing assumptions. ST VID/PID alone is not identity.

Use sector erase for the image's occupied sectors and read-back verification. The diagnostic must remain in DFU after programming: direct ROM-to-application execution is not allowed because the firmware requires cold-reset state. No arming, failsafe or flight-enable code is changed.

## First installation and verification

1. Bare board, USB power only. Use the independently verified BOOT path to enter ROM DFU.
2. Select Motolab MLTEMPF4 USB diagnostic, or explicitly complete the custom profile. Confirm reference assumptions and recovery. A disposable bare board does not need a settings backup.
3. Load `bobflight-mltempf4-usb-diagnostic.hex`. Do not select an F7 target as a workaround.
4. Select the intended ST ROM DFU device, acknowledge the board match, then flash. A layout mismatch must stop before erase/program. Report the exact error rather than bypassing it.
5. After successful write/readback verification, unplug USB, remove the BOOT bridge and reconnect USB. BOOT entry is confirmed for the owner's board; restoration of firmware through DFU remains untested.
6. Use the dedicated read-only diagnostic console. It verifies the diagnostic banner and offers only `version`, `status` and `help`. It is separate from normal configuration access, which stays locked. Expected status: stage 8, error 0, increasing uptime.
7. If USB never enumerates, disconnects repeatedly, reports an error or the board heats unexpectedly, unplug it and return to the confirmed BOOT recovery route. Do not add motors or external power to this first test.

Flash verification is not proof of application startup, USB stability, sensor functionality, persistent settings or flight readiness. Console identity names the reference firmware, not an automatically detected physical board.

## Software checks for this update

All 52 configurator CI command steps passed locally, including typechecking, production build, existing F7 journeys, new known/custom-board selection checks and diagnostic console tests. The console tests include cancellation while selecting/opening a port and while a command write is pending, and assert that stream locks are released before close. The existing diagnostic HEX also passed an actual protocol DFU model with byte-for-byte readback and no manifestation/jump. These are software/model results, not physical USB or flash qualification.

The diagnostic rebuilt successfully, its two image/parser tests passed, the unchanged firmware code passed 151 CTest targets again, and the F745 cross-build check passed. No arming, failsafe, motor-enable or flight-readiness changes are included. Hardware installation remains the next test.

## Missing browser interface names

The reported Windows browser exposes the STM32 ROM DFU interface and alternate settings but returns null for each interface name. When the selected name is absent or blank, the flasher now reads USB device, configuration, language and interface-string descriptors through standard control IN requests. It resolves the active configuration value to its descriptor index and matches the selected interface/alternate exactly. No hardcoded string index, flash-density assumption or language is substituted.

The resulting string must still pass the original F405xG sector-layout check before DFU erase/program operations. A nonempty but incompatible browser-provided layout is not replaced by a fallback. Missing, malformed, stalled, oversized or inconsistent descriptors stop the operation with a specific error; cancellation during descriptor reads issues no subsequent DFU control write. This is a configurator-only correction, so the existing diagnostic HEX remains applicable. A physical successful descriptor read and flash still require the board test.
