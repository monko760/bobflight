# Local target / HEX builder

Flasher Stage 2 selects the board. Stage 3 can now **Build HEX**, load the result through the existing image validator, and download it. Importing a HEX still works. Nothing is automatically flashed. Board-match acknowledgements, DFU geometry checks and explicit Flash remain required.

## Supported recipes

| Selection | Built image |
|---|---|
| Kakute F7 HDV | Existing development main firmware, unchanged arming/failsafe policy |
| Matek F722-PX | Sensor/CRSF candidate with nonvolatile Save; no motor output, OSD or onboard logging |
| T-Motor F7 V2 | Existing sensor-only main firmware, no motor output |
| Motolab Tempest F4 / MLTEMPF4 | Experimental USB-only diagnostic |
| Custom / unknown | That same F405xG USB reference profile, only after selecting STM32F405, 1024 KiB and 8 MHz HSE |

The generic profile is **not arbitrary board generation**. It leaves motors, sensors, receiver, UARTs and settings storage unassigned. Confirm USB PA11/PA12, PA9 unchanged, voltage and independent BOOT recovery in the existing controls before flashing. Its firmware identifies itself as the MLTEMPF4 reference, not a newly qualified custom board. F411, H7, other crystals/densities and generic F7 pin maps have no build recipe here and are refused. This does not change the main firmware target registry's support declarations.

## Local requirements

Run the trusted Git source checkout, not a static deployed site. Use Node 20+, Git, Python 3, ARM GCC and arm-none-eabi-objcopy on PATH. F7 builds also need CMake, PyYAML and Make (native **mingw32-make.exe** on Windows). MSYS Make is not silently used with the MinGW generator.

Optional `BOBFLIGHT_TOOL_ROOT` points at the directory containing existing `arm-gnu-toolchain-*` and `cmake-*` installation folders, each with `bin`. Windows also checks the established `C:\TDM-GCC-64\bin` location. No tools are downloaded or installed by the compiler endpoint.

From the configurator directory: `npm ci`, `npm --prefix protocol run build`, then `npm run dev`. The dev server defaults to `127.0.0.1:5173`. `start-configurator-builder.ps1` at repository root performs these frontend preparation steps on Windows; pass `-ToolRoot` if the tools are stored in another checkout. It does not compile or flash firmware at launch.

Select a target, then Build HEX. A clean committed source tree is required before and after compilation. The two generated catalog sources use explicit LF checkout rules so Windows newline conversion does not create false dirty-source failures. Real changes to those files still block a build. Failed builds clear the previously loaded image and never reuse an old output. Successful results show the source revision, SHA-256 of the downloaded HEX text, profile and bounded compiler log. The browser checks transfer integrity and passes the image into the existing target validation. A checksum is not a signature or hardware qualification.

## Scope and protections

The compiler runs on the local computer, only with the Vite development server. Static production/preview hosting has no compiler: Build HEX reports unavailable, while HEX import remains usable. No cloud service is involved.

The service accepts loopback sockets and loopback Host headers, same-origin requests, a per-server random build token and a small JSON selection schema. It rejects supplied paths, commands, compiler flags, unsupported selections and concurrent builds. Known commands use argument arrays with `shell:false`. Builds have deadlines, private temporary directories and bounded logs. Disconnecting the build request aborts the active subprocess tree; results are discarded on target changes/unmount. Toolchain commands execute trusted project source, not a sandbox for untrusted repositories. Do not proxy or expose the development server to the network.

F7 outputs pass the existing independent image check and provenance publisher. F405 outputs pass the existing diagnostic validator. Neither recipe writes a controller, changes firmware settings or performs a software bootloader command. F405 still has only help/status/version; main F7 configuration persistence and CLI behaviour are untouched.

## Checks

`npm run test:local-builder` covers endpoint restrictions and UI build flow; normal flasher journey/safety suites continue to run. Test on Windows as well before treating a new toolchain installation as qualified. First use should build/download without flashing, check the selected board/profile/revision, then follow the normal USB-only/props-off flashing procedure if an installation is intended.

Matek installation, sparse-HEX settings layout and hardware checks: [bring-up guide](../bobflight-firmware/boards/matek-ir/BRINGUP.md).
