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
| `mcu` | `target` (id in `targets/mcus`), `part`, `hse_mhz`, `flash_kib`, `linker_script` |
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
