# IR verify → codegen flow

Pins enter firmware **only** through owned board IR. No Betaflight `config.h`.
No invented T-Motor MCU pins.

```
OEM docs / silkscreen / bench measure
        │
        ▼
/workspace/board-defs/tmotor/*.yaml     (Hardware; schema in _schema/)
        │   status: stub | draft | bf-derived | verified | golden | ready
        ▼
boards/   copies or pointer (verified / bf-derived IR for bind targets)
        │
        ▼
CMake -DBOBFLIGHT_BOARD=dummy|tmotor_f7_v2|kakute_f7_hdv
        │  scripts/ir_codegen.py <ir.yaml>
        │  → ${CMAKE_BINARY_DIR}/generated/board/pins_generated.h
        ▼
board_init() / board_ir_load_*()
        │
        ▼
board_t  ──►  drivers via board_get()
              MMIO only if (ir_verified || ir_bf_derived) && !is_dummy
```

## CMake board select (LANDED)

```cmake
set(BOBFLIGHT_BOARD "dummy" CACHE STRING "Board IR id: dummy | tmotor_f7_v2 | kakute_f7_hdv")
```

| Flag | Effect |
|------|--------|
| `-DBOBFLIGHT_BOARD=dummy` (default) | Fail-closed stub IR; host smoke contract |
| `-DBOBFLIGHT_BOARD=tmotor_f7_v2` | Explicit F7 V2 bind; packs pins from owned IR |
| `-DBOBFLIGHT_BOARD=kakute_f7_hdv` | Holybro Kakute F7 HDV (STM32F745); bf-derived IR; motors 5–6 deferred |

Codegen runs at **configure time** into the **build tree**:
`${CMAKE_BINARY_DIR}/generated/board/pins_generated.h`.
That directory is first on the include path, so `#include "board/pins_generated.h"`
picks the selected board. Checked-in `src/board/pins_generated.h` remains the
**dummy fallback** (do not overwrite it from CMake).

IR YAML resolution:

- `dummy` → `boards/dummy.yaml`
- `tmotor_f7_v2` → `boards/tmotor-ir/tmotor_f7_v2.yaml` if present, else
  `/workspace/board-defs/tmotor/tmotor_f7_v2.yaml`
- `kakute_f7_hdv` → `boards/holybro-ir/kakute_f7_hdv.yaml` if present, else
  `/workspace/board-defs/holybro/kakute_f7_hdv.yaml`

Manual / dry-run:

```bash
python3 scripts/ir_codegen.py --dry-run boards/dummy.yaml -o /tmp/pins.h
```

## Status gate

| IR `meta.status` | Codegen | Firmware |
|------------------|---------|----------|
| `stub` / `draft` | Always `HAL_PIN_INVALID` | Dummy path; `board: dummy`; `mmio: denied` |
| `bf-derived` | Pin packing **ON**; `ir_bf_derived` | MMIO allowed with BF-derived provenance; not clean-room |
| `verified` / `golden` / `ready` | Pin packing **ON**; `ir_verified` | MMIO allowed when not dummy |
| missing file | Configure `FATAL_ERROR` | Keep checked-in dummy header |

`boards/dummy.yaml` is the in-tree stub (no pin numbers). Drivers never `#define PA4`.
Do not invent pins. Do not vendor GPL `config.h`.

## Dual-board CI + bring-up

- Matrix (dummy + `tmotor_f7_v2` + `kakute_f7_hdv`; F722 for V2, F745 for Kakute): `scripts/test_dual_board_ci.sh`
  — uses **cmake-BOBFLIGHT_BOARD** selection mode (no pins_generated.h swap).
- Default host CLI smoke (dummy contract): `scripts/test_host_cli.sh`
- Explicit F7 V2 host bind: `BOBFLIGHT_BOARD=tmotor_f7_v2 ./scripts/test_host_cli.sh`
- First-flash checklist: `docs/BRINGUP-F7-V2.md`

## First-flight target

- **Primary:** T-Motor F7 V2 — `board_id: tmotor_f7_v2` (F722 toolchain)
- **Also bound:** Holybro Kakute F7 HDV — `board_id: kakute_f7_hdv` (F745 toolchain; motors 5–6 deferred)
- **Hold:** Velox F7 SE — until asked

Dummy remains the default configure. Live boards need an **explicit** `-DBOBFLIGHT_BOARD=…` bind.
MCU Kakute: `-DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake -DBOBFLIGHT_BOARD=kakute_f7_hdv`.
