# boards/ — verified IR only

This directory holds **owned** board Intermediate Representation used by BobFlight
firmware (Apache-2.0). Do **not** drop Betaflight `config.h` / unified targets here.

## Source of truth for T-Motor F7 IR

Canonical catalog (may live outside this git tree during bring-up):

```text
/workspace/board-defs/tmotor/
```

Schema: `/workspace/board-defs/_schema/board-ir.schema.json`

Until Hardware marks an IR `verified` / `ready`, firmware builds with the
**dummy** board (`board_id: dummy`, all pins `HAL_PIN_INVALID`). CLI `status`
prints `board: dummy`.

## Policy

- Pins come only from OEM docs → owned YAML IR → optional `scripts/ir_codegen.py`
  → `src/board/pins_generated.h`.
- Never invent T-Motor MCU pin numbers.
- Never paste GPL flight-controller target files.

See `docs/IR-CODEGEN.md` for the verify → codegen flow.

## Holybro Kakute F7 HDV IR

Canonical catalog (outside this git tree during bring-up):

```text
/workspace/board-defs/holybro/
```

Symlink: `boards/holybro-ir` → that path. Pointer note: `boards/HOLYBRO-IR.path`.

`-DBOBFLIGHT_BOARD=kakute_f7_hdv` packs bf-derived pins (MPU6000 SPI4, UART3 CRSF).
Motors 5–6 are present in IR but deferred (firmware max 4). MCU is **STM32F745** —
use `cmake/stm32f745.cmake`. Do not vendor GPL `config.h`.
