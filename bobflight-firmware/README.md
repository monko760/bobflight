# BobFlight firmware

**BobFlight** is an independent, **Apache-2.0**, clean-room flight-controller
firmware (Path B). It is **not** a fork of Betaflight, INAV, EmuFlight, or
Cleanflight, and must not contain their sources or `config.h` targets.

Skeleton goal: **compile + USB CLI + cooperative realtime cascade stubs + IR
hooks**. Real gyro / DShot / RX bodies wait for a **verified** owned board IR.

## Path B (clean-room)

| Do | Do not |
|----|--------|
| Own HAL, scheduler, flight, drivers | Copy BF / INAV / Emu / CF trees |
| Pins from owned IR under `board-defs` | Invent T-Motor MCU pin numbers |
| Apache-2.0 + DCO + clean-room attestation | Paste GPL `config.h` into `boards/` |

See `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`.

## MVP scope (in tree now)

- MCU bring-up via **abstract HAL** (host stubs + STM32F722 placeholder)
- Cooperative scheduler (8 kHz gyro / denom 2 cascade + background)
- Dummy board IR (`board: dummy`, all pins invalid)
- Stubs: gyro, filter, rate PID, QUADX mixer, DShot TX, CRSF RX
- Arm / failsafe state machines (arm refuses if gyro unhealthy)
- USB CDC CLI: `help`, `version`, `status`, `arm`, `disarm`, `reboot`
- Persist stub (RAM defaults)
- Safety: motors idle at boot; no spin until armed + healthy gyro

## Deferred

OSD · blackbox · GPS/baro/mag · bidir DShot / RPM · dyn notch · MSP / stock
Configurator · analog ESC · LED/VTX · RTOS · multi-board interpreter ·
ANGLE/HORIZON.

## How board IR plugs in

1. Hardware publishes OEM-sourced YAML under
   **`/workspace/board-defs/tmotor/`** (symlink: `boards/tmotor-ir`).
2. Schema: `/workspace/board-defs/_schema/board-ir.schema.json`.
3. Select with CMake `-DBOBFLIGHT_BOARD=…` (default `dummy`). Codegen writes
   `${CMAKE_BINARY_DIR}/generated/board/pins_generated.h`; checked-in
   `src/board/pins_generated.h` is the dummy fallback.
4. `board_t` fields match IR keys (`mcu`, `gyro`, `motors`, `uart.serial_rx`,
   `usb`). Drivers consume `board_get()` — they never hardcode `PAx`.

Default configure stays **dummy** / fail-closed. F7 V2 is an explicit bind.

## Layout

```
src/app/       main + init
src/sched/     scheduler + cascade tasks
src/flight/    pid, mixer, rates, arming, failsafe
src/drivers/   gyro, dshot, rx/crsf, cli, persist
src/hal/       abstract HAL (host/ + stm32f7/)
src/board/     board_t, ir_load, pins_generated.h
boards/        verified IR only (+ pointers to board-defs/tmotor, board-defs/holybro)
include/       bobflight/version.h
docs/          ARCHITECTURE.md, HAL.md, IR-CODEGEN.md, BRINGUP-KAKUTE-F7-HDV.md, BRINGUP-F7-V2.md
scripts/       ir_codegen.py, test_host_cli.sh, test_dual_board_ci.sh
cmake/         stm32f722.cmake + stm32f745.cmake toolchain stubs
```

## Build notes

### Host smoke (no MCU) — recommended first

Board select (default **dummy** / fail-closed):

```bash
cmake -S . -B build-host                                 # dummy default
cmake -S . -B build-host-f7v2 -DBOBFLIGHT_BOARD=tmotor_f7_v2
cmake -S . -B build-f722 -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake -DBOBFLIGHT_HOST_SMOKE=OFF -DBOBFLIGHT_BOARD=tmotor_f7_v2
```

```bash
cmake --build build-host
./build-host/bobflight_host
```

Defines `BOBFLIGHT_HOST`; uses `src/hal/host/hal_host.c`. Exercises scheduler
cascade for a bounded slice count, then exits `0`. Pins come from
`${CMAKE_BINARY_DIR}/generated/board/pins_generated.h` (checked-in
`src/board/pins_generated.h` is the dummy fallback).

Automated CLI/status contract:

```bash
./scripts/test_host_cli.sh                              # dummy default
BOBFLIGHT_BOARD=tmotor_f7_v2 ./scripts/test_host_cli.sh # F7 V2 bind
./scripts/test_dual_board_ci.sh                         # dual-board matrix
```

**Primary first-flash (PM):** Kakute F7 HDV — `docs/BRINGUP-KAKUTE-F7-HDV.md` (STM32F745; CMake/F745 target still BLOCKED for FW Lead). Secondary F7 V2: `docs/BRINGUP-F7-V2.md`. IR details: `docs/IR-CODEGEN.md`.

### STM32F722 cross (toolchain stub)

```bash
cmake -S . -B build-f722 \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=tmotor_f7_v2
cmake --build build-f722
```

Needs `arm-none-eabi-gcc`. Produces `bobflight.elf` / `.hex` / `.bin` using
owned startup + `cmake/stm32f722.ld`. ARM CMSIS Core (Apache-2.0) is vendored
at `third_party/cmsis-core/`. ST Cube / CMSIS-Device are **not** vendored.
MMIO stays gated on IR provenance (dummy = fail-closed; bf-derived/verified allow).


### STM32F745 cross (Kakute F7 HDV)

```bash
cmake -S . -B build-f745-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv
cmake --build build-f745-kakute
# → build-f745-kakute/bobflight.elf /.hex /.bin
```

Kakute IR is bf-derived (pointer `boards/holybro-ir`). Motors 5–6 are in IR but
deferred (firmware packs/uses max 4). Do not vendor GPL `config.h`.

## CLI minimum

`help` · `version` · `status` (board, gyro bind, dshot_bound, rx, mmio, arm) ·
`arm` / `disarm` · `reboot`

No MSP in the skeleton.

## License

Apache-2.0. Copyright 2026 Robert Leclercq. See `LICENSE` and `NOTICE`.
