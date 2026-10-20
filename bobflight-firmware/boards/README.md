<!-- SPDX-License-Identifier: Apache-2.0 -->
# boards/ — one owned definition per board

`<board_id>.yaml` is the single source of truth for that board's pins, sensors, USB,
motor outputs, LED/beeper, UARTs, receiver default, Configurator listing and HEX-builder
recipe. See [docs/BOARDS.md](../docs/BOARDS.md) for the schema and how to add a board.

Policy:

- Pins come only from cited, owned facts; unknown is `absent`. Never invent pins.
- Never paste Betaflight `config.h` / unified targets here (GPL); restate facts with a citation.
- `dummy.yaml` is the host build (status `stub`: every pin `HAL_PIN_INVALID`).
- `mltempf4.yaml` and `custom_f405xg_usb.yaml` are F405 USB-only diagnostic profiles,
  not CMake targets.

Validate with `python3 scripts/board_def.py`.
