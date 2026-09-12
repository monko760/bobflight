# Bring-up dry-run — T-Motor F7 V2 (software-only)

**Parent procedure:** [`BRINGUP-F7-V2.md`](./BRINGUP-F7-V2.md)  
**board_id:** `tmotor_f7_v2`  
**MCU (IR):** `STM32F722`  
**IR status:** `bf-derived` (not bench-verified) — GPL pin facts in YAML; firmware `.c` stays Apache-2.0  
**Scope:** first-flash readiness **without** a physical board. No flash executed. No vendor outreach. Pins quoted from IR / bring-up doc only.  
**Dry-run date:** 2026-09-05 (PT)

---

## Overall status

| Result | Meaning |
|--------|---------|
| **PASS (software gates)** | F722 hex for `tmotor_f7_v2` present and board-selected; host CLI contract green for this board |
| **BLOCKED (hardware gates)** | DFU flash, CDC on silicon, gyro whoami, DShot props-off, CRSF on wire — require bench |

**Cascade host:** green (`bobflight host smoke: ok (cascade exercised)`).  
**dfu-util on this host:** **not installed** (command documented; flash not attempted).

---

## Artifact verification (F722 / `tmotor_f7_v2`)

Preferred existing build dir (valid — no rebuild required):

| Item | Value |
|------|-------|
| Build dir | `/workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2` |
| CMake board | `BOBFLIGHT_BOARD:STRING=tmotor_f7_v2` (from `CMakeCache.txt`) |
| Toolchain | `cmake/stm32f722.cmake` → `BOBFLIGHT_TARGET_MCU:STRING=STM32F722` |
| Host smoke | `BOBFLIGHT_HOST_SMOKE:BOOL=OFF` |
| Generated IR | `generated/board/pins_generated.h` — `BOARD_GENERATED_ID "tmotor_f7_v2"`, `BOARD_GENERATED_IR_BF_DERIVED 1` |

### Files

| Path | Size (bytes) | mtime (PT) |
|------|-------------:|------------|
| `/workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.hex` | 123004 | 2026-09-05 14:51:51 PT |
| `/workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.elf` | 423520 | 2026-09-05 14:51:51 PT |
| `/workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.bin` | 43712 | 2026-09-05 14:51:51 PT |

`arm-none-eabi-size` on `.elf`: text=41956 data=1756 bss=2848 dec=46560.

**Also present (same board cache):** `/workspace/bobflight-firmware/build-f722/` with identical sizes; prefer the explicit `build-f722-ci-tmotor_f7_v2` tree for this dry-run.

**Rebuild command (if stale later):**

```bash
cmake -S . -B build-f722-ci-tmotor_f7_v2 \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=tmotor_f7_v2
cmake --build build-f722-ci-tmotor_f7_v2
```

---

## Exact DFU flash command (do **not** run in this dry-run)

Typical ST USB DFU for STM32F722 (app at flash base `0x08000000`):

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.hex
```

Equivalent with `.bin` (same address / leave):

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.bin
```

**Install hint (this box):** `dfu-util` was **not** on `PATH` (`dfu-util --version` → command not found). On Debian/Ubuntu: `sudo apt install dfu-util`.

Enter DFU via BOOT0 / board DFU path per Hardware photos — bring-up doc: *no invented silk*.

---

## Preflight checklist (from BRINGUP + bench checklist)

| # | Check | Source | Dry-run |
|---|-------|--------|---------|
| P1 | **Props OFF** for entire bring-up | BRINGUP Safety | **BLOCKED** — no board; reaffirm before any power/USB |
| P2 | Arm refuses while gyro unhealthy; do not bypass | BRINGUP Safety | **PASS** (host) — `arm refused (gyro unhealthy or failsafe)` |
| P3 | Motors idle at boot; no intentional spin until whoami + props-off DShot | BRINGUP Safety | **BLOCKED** — hardware |
| P4 | IR **bf-derived** warning acknowledged; `.c` stays Apache; no BF `config.h` | BRINGUP Safety / IR provenance | **PASS** — documented; generated header marks GPL pin macros |
| P5 | DFU button / BOOT0 path known (photos; no invented silk) | BRINGUP §1; bench §0 | **BLOCKED** — no photos/board this run |
| P6 | USB cable + board power ready | BRINGUP §1–2; bench §4 | **BLOCKED** — no hardware |
| P7 | Cascade host green | BRINGUP §0 | **PASS** — host smoke ok (cascade exercised) |
| P8 | Dual CI authority (`scripts/test_dual_board_ci.sh`) | BRINGUP §0 / §6 | **PASS (partial)** — `BOARD=tmotor_f7_v2 ./scripts/test_host_cli.sh` → PASS; full dual matrix not re-executed in this session (classifier block on script). Existing F722 + host CI dirs for `tmotor_f7_v2` present with correct `BOBFLIGHT_BOARD` |
| P9 | CMake `-DBOBFLIGHT_BOARD=tmotor_f7_v2` | BRINGUP §0; task | **PASS** — landed in cache (`BOBFLIGHT_BOARD:STRING=tmotor_f7_v2`) |
| P10 | `bobflight.hex` exists for F722 / this board | BRINGUP §0 | **PASS** — path/size above |
| P11 | `dfu-util` available on flash host | BRINGUP §1 | **FAIL** (tooling) — not installed; install before bench flash |
| P12 | Gyro package / HSE still unknown until bench | IR provenance; bench §0 | **BLOCKED** — IR `gyro.chip: MULTI_BF_TMOTORF7V2`, `mcu.hse_mhz: null` |

---

## Walk of BRINGUP-F7-V2.md gates

### Safety (mandatory)

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| Props OFF policy understood | Yes (process) | **PASS** (documented) |
| Arm refuse when gyro unhealthy | Host yes | **PASS** (host CLI) |
| No spin until whoami + DShot props-off | Hardware | **BLOCKED** |
| bf-derived / Apache `.c` boundary | Yes | **PASS** |

### §0 Prep (host / CI)

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| IR codegen / `BOBFLIGHT_BOARD=tmotor_f7_v2` | Yes | **PASS** — CMake switch present; pins_generated for `tmotor_f7_v2` |
| Host smoke / dual matrix | Yes | **PASS (host cell)**; dual full script not re-run here |
| F722 image `bobflight.{elf,hex,bin}` | Yes | **PASS** |

### §1 DFU → flash

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| Enter STM32 DFU | No | **BLOCKED** |
| Flash via `dfu-util` | Command only | **BLOCKED** (no flash); command documented; **dfu-util missing** |
| Power-cycle / leave DFU | No | **BLOCKED** |

### §2 USB CDC CLI

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| CDC ACM enumerates | No (MCU) | **BLOCKED** |
| ready banner + CLI | Host contract yes | **PASS** (host) |
| `help` / `version` / `status` fields | Host yes | **PASS** — `board: tmotor_f7_v2`, `ir: bf-derived`, `gyro_ok: no`, `dshot_bound: 4/4`, `rx: CRSF bound`, `mmio: allowed (bf-derived)`; no `PAx` / no “betaflight” in CLI |

### §3 Gyro whoami

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| SPI1 + CS `PA4` + EXTI `PC4` (IR quote) | Pins known from IR; silicon no | **BLOCKED** |
| Package marking → real `gyro.chip` | Bench | **BLOCKED** |
| `gyro_ok: yes` | Silicon | **BLOCKED** (host correctly `gyro_ok: no`) |

### §4 Props-off DShot (M1–M4)

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| Props removed | Hardware | **BLOCKED** |
| Bind M1–M4 IR pins / DShot600 intent | Host bind count | **PASS (bind meta)** — `dshot_bound: 4/4`; spin check **BLOCKED** |

IR M1–M4 (quote-only from BRINGUP): PB0/TIM3_CH3, PB1/TIM3_CH4, PB4/TIM3_CH1, PB5/TIM3_CH2.

### §5 CRSF / SerialRX

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| Wire RX UART2 TX `PA2` RX `PA3` CRSF | Hardware | **BLOCKED** |
| Host status `rx: CRSF bound` | Host yes | **PASS** (host contract) |
| Failsafe TX off | Hardware | **BLOCKED** |

### §6 Hand-off

| Gate | Verifiable without HW? | Dry-run |
|------|------------------------|---------|
| Record PASS/FAIL | This doc | **PASS** |
| Point Hardware at bench checklist | Process | **PASS** — `/workspace/board-defs/tmotor/BENCH-CHECKLIST-TMOTOR-F7-V2.md` |
| Keep GPL boundary | Process | **PASS** |
| Dual-board regression | Script | **PASS (partial)** — see P8 |

---

## Note on BRINGUP “Blockers” section

`BRINGUP-F7-V2.md` still lists “CMake/env `BOBFLIGHT_BOARD` switch not yet in tree.” **This dry-run found the switch landed** (`BOBFLIGHT_BOARD:STRING=tmotor_f7_v2` in F722 and host CI caches; dual CI script comments `LANDED`). Remaining real blockers: physical board, `dfu-util` install on flash host, gyro whoami / HSE bench fill, IR still `bf-derived` until Hardware verifies.

---

## GPL / license reminder

- IR pin data is **bf-derived** (`license.pin_data: GPLv3-derived`).  
- Do **not** paste Betaflight source or vendor `config.h`.  
- Firmware `.c` remains Apache-2.0; generated header comments retain the GPL pin-macro notice.

---

## Dry-run summary for PM

| Item | Value |
|------|-------|
| Overall | **Software-ready / hardware-BLOCKED** |
| Hex | `/workspace/bobflight-firmware/build-f722-ci-tmotor_f7_v2/bobflight.hex` (123004 bytes) |
| Board CMake | `-DBOBFLIGHT_BOARD=tmotor_f7_v2` verified |
| dfu-util | **Not installed** — `sudo apt install dfu-util` |
| Host CLI | **PASS** for `tmotor_f7_v2` |
| Next bench | Install dfu-util → props off → DFU flash hex → CDC → whoami → DShot props-off → CRSF |
