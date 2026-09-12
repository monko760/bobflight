# Bring-up — T-Motor F7 V2 (first flash)

Physical DFU HOLD lifted (Configurator board-session ready); Kakute remains primary.

**Board IR:** `/workspace/board-defs/tmotor/tmotor_f7_v2.yaml`  
**board_id:** `tmotor_f7_v2`  
**MCU (IR):** `mcu.family: STM32F722`  
**IR status:** `meta.status: bf-derived` (not bench-verified)  
**Bench checklist (Hardware):** `/workspace/board-defs/tmotor/BENCH-CHECKLIST-TMOTOR-F7-V2.md`  
**CI matrix:** `scripts/test_dual_board_ci.sh`  
**Dry-run (software-only):** [`BRINGUP-F7-V2-DRYRUN.md`](./BRINGUP-F7-V2-DRYRUN.md)  

Do **not** invent silkscreen labels. Pin names below are quoted from the owned IR only.

---

## Safety (mandatory)

- **Props OFF** for the entire bring-up (remove propellers before power or USB).
- Arm must refuse while gyro is unhealthy; do not bypass.
- Motors idle at boot; no intentional spin until whoami + props-off DShot checks pass.
- IR is **bf-derived** (GPL pin facts in YAML). Firmware `.c` stays Apache-2.0 — do not vendor Betaflight `config.h`.

---

## IR provenance warnings

| Fact | Source |
|------|--------|
| Pin data license | IR `license.pin_data: GPLv3-derived` |
| Attribution | Betaflight target TMOTORF7V2 / TMTR |
| Provenance | `meta.provenance: betaflight-target-derived` |
| Clean-room | **No** — exception scoped to this board IR only |
| Bench-verified | **No** — `meta.status` is `bf-derived`, not `verified` |
| Gyro chip | IR `gyro.chip: MULTI_BF_TMOTORF7V2` (rev-dependent; read package on bench) |
| HSE | IR `mcu.hse_mhz: null` — fill from bench before golden |

See also: `tmotor_f7_v2.PROVENANCE.md`, `NOTICE-BF-DERIVED-IR.md` under board-defs.

---

## IR fields used in this checklist (quote-only)

**Gyro (SPI)** — from IR `gyro.*`:

| Field | IR value |
|-------|----------|
| `spi_bus` | `1` |
| `cs_pin` | `PA4` |
| `exti_pin` | `PC4` |
| `spi_pins.sck` | `PA5` |
| `spi_pins.miso` | `PA6` |
| `spi_pins.mosi` | `PA7` |
| `chip` | `MULTI_BF_TMOTORF7V2` |

**Motors M1–M4 (MVP)** — from IR `motors.channels[]` + `protocol_default: DShot600`:

| index | pin | timer | channel |
|-------|-----|-------|---------|
| 1 | PB0 | TIM3 | 3 |
| 2 | PB1 | TIM3 | 4 |
| 3 | PB4 | TIM3 | 1 |
| 4 | PB5 | TIM3 | 2 |

(IR also lists channels 5–8; not first-flight MVP.)

**Serial RX** — from IR `uart.serial_rx`:

| Field | IR value |
|-------|----------|
| `uart` | `2` |
| `pins.tx` | `PA2` |
| `pins.rx` | `PA3` |
| `protocol_default` | `CRSF` |

**USB** — IR `usb.enable_cdc: true`.

---

## 0. Prep (host / CI)

- [ ] `python3 scripts/ir_codegen.py boards/tmotor-ir/tmotor_f7_v2.yaml -o src/board/pins_generated.h`  
      (or `-DBOBFLIGHT_BOARD=tmotor_f7_v2` once FW Lead lands the CMake switch)
- [ ] Host smoke: `./scripts/test_dual_board_ci.sh` (or `BOARD=tmotor_f7_v2 ./scripts/test_host_cli.sh` after select)
- [ ] F722 image:  
      `cmake -S . -B build-f722 -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake -DBOBFLIGHT_HOST_SMOKE=OFF`  
      `cmake --build build-f722` → `build-f722/bobflight.{elf,hex,bin}`

**Pass:** dual matrix PASS for `tmotor_f7_v2` host + f722 cells.  
**Fail:** codegen refused / CLI contract mismatch / missing `bobflight.elf`.

---

## 1. DFU → flash

- [ ] Enter STM32 DFU (BOOT0 / board DFU path per Hardware photos — no invented silk here)
- [ ] Flash `bobflight.bin` / `.hex` via `dfu-util` (or equivalent)
- [ ] Power-cycle / leave DFU

**Pass:** DFU enumerates; flash completes without error; board reboots to app.  
**Fail:** no DFU device; verify-failed; brown-out.

---

## 2. USB CDC CLI

- [ ] USB cable; CDC ACM enumerates (`usb.enable_cdc: true` in IR)
- [ ] Open serial; expect ready banner + CLI
- [ ] `help` → command list
- [ ] `version` → BobFlight version string
- [ ] `status` → expect (host-equivalent contract on MCU when wired):
  - `board: tmotor_f7_v2`
  - `ir: bf-derived`
  - `gyro_ok: no` until whoami lands
  - `dshot_bound: 4/4` when M1–M4 IR pins pack
  - `rx: CRSF bound` when UART2 IR packs
  - `mmio: allowed (bf-derived)`
  - **no** pin tokens (`PAx`) and **no** “betaflight” string in CLI

**Pass:** CDC up; status board id + bf-derived IR; no pin/BF leaks.  
**Fail:** no CDC; wrong `board:`; pin or BF string leak.

---

## 3. Gyro whoami

- [ ] Props still **OFF**
- [ ] SPI1 + CS `PA4` + EXTI `PC4` (IR) — driver whoami when implemented
- [ ] Read package marking → replace `MULTI_BF_TMOTORF7V2` with real `gyro.chip` on bench (Hardware checklist)
- [ ] `status` → `gyro_ok: yes` only after a real whoami match

**Pass:** whoami matches identified chip; `gyro_bind` no longer stuck unbound/no-cs.  
**Fail:** SPI timeout; unexpected whoami; do not arm.

---

## 4. Props-off DShot (M1–M4)

- [ ] Confirm **props removed**
- [ ] Protocol intent: IR `motors.protocol_default: DShot600`
- [ ] Bind uses IR pins/timers above (M1–M4 only for MVP)
- [ ] Idle / disarm: no motor spin; optional ESC beep acknowledge only
- [ ] Do **not** arm for this step unless procedure explicitly requires it with props off and gyro healthy

**Pass:** `dshot_bound: 4/4`; ESCs acknowledge idle; **no rotation**.  
**Fail:** missing bind; unexpected spin → power cut immediately.

---

## 5. CRSF / SerialRX

- [ ] Wire RX to IR SerialRX: UART `2`, TX `PA2`, RX `PA3`, protocol `CRSF`
- [ ] Transmitter on; link up
- [ ] `status` → `rx: CRSF bound` (and frame freshness when RX path is live)
- [ ] Failsafe: TX off → failsafe asserts; motors stay safe

**Pass:** CRSF frames accepted on UART2 pins from IR; failsafe on loss.  
**Fail:** unbound UART; no frames; failsafe silent.

---

## 6. Hand-off

1. Record PASS/FAIL per step with date.  
2. Point Hardware at `BENCH-CHECKLIST-TMOTOR-F7-V2.md` to move IR toward `verified`.  
3. Do not promote IR to Apache pin facts; keep GPL boundary in YAML / generated header comments.  
4. Dual-board regression: `./scripts/test_dual_board_ci.sh`.

---

## Blockers (FW Lead / Hardware)

- CMake/env **`BOBFLIGHT_BOARD`** switch not yet in tree — dual CI uses `ir_codegen.py` prep path until it lands.
- Gyro whoami body and full MCU CDC path may still be stubbed; treat host contract as the software gate, bench for silicon.
- IR remains bf-derived until Hardware fills bench checklist and sets `verified`.
