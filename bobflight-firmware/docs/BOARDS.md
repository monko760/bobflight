<!-- SPDX-License-Identifier: Apache-2.0 -->
# Board definitions: one file per board

Every board BobFlight knows about is described by exactly one file,
`bobflight-firmware/boards/<board_id>.yaml`. That file is the only board input to:

| Consumer | Reads it through |
| --- | --- |
| Pin header codegen (`pins_generated.h`, incl. the selectable-UART table) | `scripts/ir_codegen.py` → `scripts/board_def.py` |
| Target registry / CMake target resolution / artifact manifests | `scripts/target_registry.py` → `scripts/board_def.py` |
| Configurator board list, target catalog and protocol board→MCU map | `npm run targets:generate` → `target_registry.py list --json` → `ui/src/targets/catalog.generated.json` |
| Configurator local HEX builder (board list, labels, custom limits, artifact names) | `scripts/local-hex-builder.mjs` and `ui/src/flasher/HexBuilder.tsx` → the generated catalog |

MCU backends stay in `targets/mcus/<mcu>.json` (they describe silicon, not boards).

## Adding a board

1. Copy the closest existing file to `boards/<board_id>.yaml`. `board_id` must equal the
   file name (lower case, `[a-z][a-z0-9_]*`).
2. Fill in facts **only** from owned, cited sources (OEM docs, a pinned reference
   revision, or bench readback). Put the citation in the header comments. Never guess a
   pin: anything unknown is `absent`. Do not paste GPL target files; restate facts.
3. Validate: `python3 scripts/board_def.py` (all boards) or
   `python3 scripts/board_def.py boards/<board_id>.yaml`.
4. `python3 scripts/target_registry.py validate`, then from `bobflight-configurator/`
   `npm run targets:generate` and commit the regenerated catalog files.
5. Host build: `cmake -B build -DBOBFLIGHT_BOARD=<board_id> && cmake --build build -j2 && ctest --test-dir build`.

A new file does **not** port drivers. Board-specific driver guards that still check
`board_id` in C (ADC, bootloader entry, config flash, DShot input-capture coupling,
CLI UART limits in `persist.c`) must be extended deliberately, and an MCU whose
`targets/mcus/*.json` status is `planned` can never produce a hardware build.

## Schema (schema_version 1)

Every top-level key is required; optional blocks are written as `absent`, never omitted.
Pins are `P<port><0-15>` (e.g. `PE4`) or `absent`. Unknown keys are rejected.

| Key | Contents |
| --- | --- |
| `schema_version` | `1` |
| `board_id`, `display_name`, `manufacturer` | identity (`manufacturer` may be `absent`) |
| `status` | `stub` / `draft` (no pins packed) or `bf-derived` / `verified` / `golden` / `ready` |
| `support` | `host-only`, `sensor-only`, `development`, or `diagnostic` (F4 USB-only image profile, never a CMake target) |
| `capabilities` | `{motor_output, usb_cdc, sd_logging}` booleans |
| `configurator` | `image_profile` (`main` / `f405-usb-diagnostic`), `build_label` (present ⇒ the local HEX builder offers it); diagnostic only: `artifact_name`, `mcu_display`, `support_label`, `menu_order`, `custom {mcu, flash_kib, hse_hz}` |
| `mcu` | `target` (id in `targets/mcus`), `part`, `hse_mhz` (4..26), `flash_kib` (generated as `BOARD_GENERATED_FLASH_KIB`, checked at boot where the board has a FLASHSIZE gate; `absent` = unverified, not checked), `linker_script` (the only linker-script source: CMake and the F405 diagnostic tool read it) |
| `usb` | `cdc`, `dm`, `dp` |
| `gyro` | `chip`, `spi_bus`, `cs`, `exti`, `sck`, `miso`, `mosi`, `orientation` (`CW0_DEG`, `CW90_DEG`, `CW180_DEG`, `CW270_DEG`, `CW180_DEG_FLIP`) |
| `baro` | `chip`, `i2c_bus`, `scl`, `sda` |
| `nor_flash` | `spi_bus`, `cs`, `sck`, `miso`, `mosi` |
| `sd` | `spi_bus`, `cs`, `sck`, `miso`, `mosi`, `detect` |
| `adc` | `vbat`, `current` |
| `motors` | list of `{index, pin, timer, channel, dma}`; indices 1..N in order (firmware packs the first 4) |
| `led` | `led0` |
| `beeper` | `{pin, inverted}` or `absent` |
| `uarts` | runtime-selectable serial-RX UARTs `{uart, tx, rx}`; `[]` means the receiver UART is fixed |
| `receiver` | default `{uart, tx, rx, protocol}`; must equal its `uarts` row when one exists |

## Validator rules (`scripts/board_def.py`, CI: `tests/test_board_schema.py`)

- Missing required field, required field set to `absent`, unknown field, duplicate key,
  tab indentation, or YAML outside the strict subset → rejected.
- Any pin used twice (sensors, buses, USB, ADC, LED, beeper, motors, UART rows) → rejected.
- Any timer/channel pair used by two motors, motor channel outside 1..4, or a timer that is
  not `TIM1`..`TIM14` → rejected. Two devices on one SPI bus → rejected.
- Support/status/capability policy (host-only has no hardware capability; hardware targets
  need a packable status and a gyro with one orientation; sensor-only has no motor output).
- Existing driver routing guards are preserved (external NOR only SPI2 PB12/PB13/PB14/PC3
  on F722; barometer only I2C1 PB8/PB9 on F722).

## Migration proof

`tests/test_board_migration_equivalence.py` (CTest `board_migration_equivalence` and the CI
"Board definitions" job) compares against frozen outputs of main 5bea523 in
`tests/golden/boards/`: generated pin headers are byte-identical apart from the source
path comment and the new UART block; main's hand-written UART tables and the new
generated table give identical `board_init()` state and `board_select_rx_uart(0..255)`
results; and the registry/catalog matches apart from the `ir` path and the new
`build_label` / `diagnostic_profiles` data.

## Validation rules (scripts/board_def.py)

- Pins: `P[A-K](0..15)`, no leading zeros, only ports the MCU has (largest package; the schema has no package field, so package-only limits are not checked).
- Buses and timers: SPI/I2C/UART numbers and timer channels must exist on the part (per-part tables from RM0090/RM0431/RM0385). MCUs without a verified table (F411, H743) cannot carry pins yet.
- DMA: `DMA1_S0`..`DMA2_S7`, each stream once; leave `absent` unless verified.
- Allowlists: gyro `MPU6000`/`ICM42688`/`BMI270`, baro `BMP280`, receiver `CRSF` (the drivers in src/drivers).
- Capabilities: `motor_output` needs motors, `sd_logging` needs `sd`, `usb.cdc` equals `capabilities.usb_cdc` (host-only exempt).
- Strings: no empty or quoted `absent`, no quotes/backslashes, max 200 chars. YAML 1.1 traps (`010`, `1:30`, `NO`, `On`, `8.0`) are errors.
- `menu_order` only on diagnostic profiles; display names unique; only `<board_id>.yaml` files (and README.md) in boards/.

## Building every board (`scripts/build_all_boards.py`, CI: "Firmware — every boards/*.yaml builds")

One command builds every `boards/*.yaml` and fails if any board does not build:

```sh
cd bobflight-firmware
python3 scripts/build_all_boards.py --out build-all-boards     # build; exit 0 only if every board built
python3 scripts/build_all_boards.py --list-flashable           # expected flashable list, builds nothing
python3 scripts/build_all_boards.py --plan                     # per-board recipe, builds nothing
```

Requirements are the same as the per-board builds: Python 3, CMake with Make or Ninja, and
`arm-none-eabi-gcc`/`objcopy` on `PATH` (CI uses the pinned toolchain from
`.github/actions/setup-arm-toolchain`). Nothing is flashed and no device is accessed.

Each board uses the recipe the repository already has for it, chosen from its definition
(no board list is written anywhere else):

| Definition | Recipe | Output |
| --- | --- | --- |
| `support: host-only` (`dummy`) | host build of `bobflight_host` | none: the target registry refuses host-only targets for hardware builds, so it is never flashable |
| `support: diagnostic` (`mltempf4`, `custom_f405xg_usb`) | `tools/build_f405_usb_diagnostic.py`, Intel HEX checked against `mcu.flash_kib` | `hex/<board_id>/<configurator.artifact_name>` |
| anything else, `image_profile: main` (`kakute_f7_hdv`, `matek_f722_px`, `tmotor_f7_v2`) | CMake cross build with the registry toolchain, `check_bootloader_image`, `scripts/publish_target_image.py` | `hex/<board_id>/bobflight-<board_id>-main.hex` and its `.hex.json` provenance manifest |

The two diagnostic profiles are built by the same tool and give the same image
(`custom_f405xg_usb.yaml`: "same diagnostic image as MLTEMPF4"); only the file name differs.

### Output contract

`--out` must be a new or empty directory, so an older HEX can never be mistaken for this
build. Inside it:

```text
boards.json                                     index (always written once building starts)
hex/<board_id>/bobflight-<board_id>-main.hex    main images
hex/<board_id>/bobflight-<board_id>-main.hex.json
hex/<board_id>/<configurator.artifact_name>     diagnostic images
logs/<board_id>.log                             build log per board
work/<board_id>/                                build trees (not part of the contract)
```

`boards.json` (`schema_version: 1`) has `ok`, `git_commit`, `tracked_source_dirty`,
`flashable` (board ids with a device HEX, sorted by `board_id`: `board_id`,
`image_profile`, `hex` path relative to the output directory, `sha256`), and `boards`
(every definition with `result` `hex`, `host-build` or `failed`, plus its log path).
`--list-flashable` prints the same `flashable` list without `sha256` and without
building, so a consumer can compare its own board list against it. Use the HEX files only
when `ok` is `true`.

### CI rule

The `firmware-all-boards` job runs `tests/test_build_all_boards.py` and then the real
build. The job fails when any board definition is invalid, any board fails to configure,
compile, link or pass its image check, any expected HEX or manifest is missing, or the
set of results differs from `boards/*.yaml`. On success the `bobflight-all-boards-hex`
artifact holds `boards.json` and `hex/`; on failure `bobflight-all-boards-logs` holds the
per-board logs.

Board identity metadata inside the HEX (planned for the safer-flashing work) is not part
of these images yet; it will join this pipeline when that lands. Today the board identity
comes from the file location, `boards.json`, the main-image manifest, and the firmware's
`version` reply after flashing.
