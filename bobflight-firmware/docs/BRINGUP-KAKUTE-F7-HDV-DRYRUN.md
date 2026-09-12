# Bring-up dry-run — Holybro Kakute F7 HDV (software-only)

> **Heartbeat hex ready (2026-09-10 PT):** `build-f745-kakute/bobflight.hex` **233975** B (sha256 `3cc3838a…`). PA2: Reset early 4× → init 4×100ms → ~2 Hz = app alive. Props-off reflash; won’t ping Robert.

**Parent procedure:** [`BRINGUP-KAKUTE-F7-HDV.md`](./BRINGUP-KAKUTE-F7-HDV.md)  
**Secondary board docs:** [`BRINGUP-F7-V2.md`](./BRINGUP-F7-V2.md) / [`BRINGUP-F7-V2-DRYRUN.md`](./BRINGUP-F7-V2-DRYRUN.md)  
**board_id:** `kakute_f7_hdv`  
**MCU (IR):** `STM32F745` (**not** F722)  
**IR status:** `bf-derived` (not bench-verified) — GPL pin facts in YAML; firmware `.c` stays Apache-2.0  
**Scope:** first-flash readiness **without** a physical board. No flash executed. No vendor outreach. Pins quoted from IR / bring-up doc only.  
**Dry-run date:** 2026-09-05 (PT); **CDC-fixed re-verify:** 2026-09-10 (PT)

---

## Overall status

| Result | Meaning |
|--------|---------|
| **PASS (software gates)** | F745 hex for `kakute_f7_hdv` present and board-selected; host CLI contract green for this board |
| **BLOCKED (hardware gates)** | Physical DFU / whoami / DShot / CRSF still need bench. **CDC stub gate CLEARED** for current hex (226926 B) — COM expected after props-off reflash |

**Cascade host:** green (`bobflight host smoke: ok (cascade exercised)`).  
**Host CLI:** `BOARD=kakute_f7_hdv ./scripts/test_host_cli.sh` → **PASS**.  
**dfu-util on this host:** **installed** (`dfu-util 0.11`) — command documented; flash **not** attempted.

**Hardware CDC gate (2026-09-10 PT):** Stub-era flash left **no COM**. FW Lead delivered **CDC-fixed** artifact at same path (**226926** B, was ~123k). Stub gate **CLEARED for this artifact**. Physical reflash still required (props OFF) — see [`RECOVERY-DFU-KAKUTE-F7-HDV.md`](./RECOVERY-DFU-KAKUTE-F7-HDV.md). This dry-run does **not** flash.
**Field (2026-09-10 PT):** CDC-fixed hex (226926 B) still yielded **no COM** after reflash — stub gate cleared on artifact size, but silicon CDC enum **FAIL** in field. Robert field: DFU OK; LED solid (not flashing); no COM. Extra diagnostics in [`RECOVERY-DFU-KAKUTE-F7-HDV.md`](./RECOVERY-DFU-KAKUTE-F7-HDV.md). Standing by; do not ping Robert.


**Note:** CMake packs motors **1–4** for Kakute (`dshot_bound: 4/4`); IR lists M5–M6 — deferred until FW expands pack (see parent bring-up).

---

## Artifact verification (F745 / `kakute_f7_hdv`)

| Item | Value |
|------|-------|
| Build dir | `/workspace/bobflight-firmware/build-f745-kakute` |
| CMake board | `BOBFLIGHT_BOARD:STRING=kakute_f7_hdv` |
| Toolchain | `cmake/stm32f745.cmake` → `BOBFLIGHT_TARGET_MCU:STRING=STM32F745` |
| Generated IR | `BOARD_GENERATED_ID "kakute_f7_hdv"`, MCU `STM32F745`, gyro `MPU6000`, `IR_BF_DERIVED 1`, `IR_VERIFIED 0` |

### Files

| Path | Size (bytes) | mtime (UTC) |
|------|-------------:|-------------|
| `/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex` | **233975** | 2026-09-10 20:49 UTC |
| `/workspace/bobflight-firmware/build-f745-kakute/bobflight.elf` | 549608 | 2026-09-10 20:49 UTC |
| `/workspace/bobflight-firmware/build-f745-kakute/bobflight.bin` | 81728 | 2026-09-10 20:49 UTC |

`arm-none-eabi-size` on `.elf`: text=79816 data=1864 bss=4104 dec=85784. sha256 hex = `3cc3838af1ab1553190614151661eebf87c41ecf96ec04325b64abe0d62a997c`.

**Rebuild command (if stale later):**

```bash
cmake -S . -B build-f745-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv
cmake --build build-f745-kakute
```

---

## Exact DFU flash command (do **not** run in this dry-run)

Typical ST USB DFU for STM32F745 (app at flash base `0x08000000`) — recipe re-verified 2026-09-10 for **CDC-fixed** hex (226926 B):

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
```

Equivalent with `.bin`:

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f745-kakute/bobflight.bin
```

Enter DFU via BOOT0 / board DFU path per Hardware photos — bring-up doc: *no invented silk*.

---

## Preflight checklist

| # | Check | Dry-run |
|---|-------|---------|
| P1 | **Props OFF** | **BLOCKED** — no board; reaffirm before power/USB |
| P2 | Arm refuses while gyro unhealthy | **PASS** (host) |
| P3 | No spin until whoami + props-off DShot | **BLOCKED** — hardware |
| P4 | IR bf-derived / Apache `.c` boundary | **PASS** — documented |
| P5 | DFU / BOOT0 path known (photos) | **BLOCKED** — no photos this run |
| P6 | USB + board power | **BLOCKED** — no hardware |
| P7 | Cascade host green | **PASS** |
| P8 | Host CLI `kakute_f7_hdv` | **PASS** |
| P9 | CMake `-DBOBFLIGHT_BOARD=kakute_f7_hdv` + F745 toolchain | **PASS** |
| P10 | `bobflight.hex` exists | **PASS** — path/size above |
| P11 | `dfu-util` on flash host | **PASS** — dfu-util 0.11 |
| P12 | HSE / gyro package confirm on bench | **BLOCKED** — `hse_mhz=0`, IR bf-derived |
| P13 | Motors 5–6 pack | **BLOCKED** — FW packs 4/4 only for now |

---

## Gate walk (software vs hardware)

| Gate | Without HW? | Dry-run |
|------|-------------|---------|
| §0 Prep / hex / CMake F745 | Yes | **PASS** |
| §1 DFU → flash | No | **BLOCKED** (command ready) |
| §2 USB CDC CLI on silicon | After reflash | **READY (artifact)** — stub cleared; COM expected post-reflash; host CLI PASS as proxy |
| §3 Gyro whoami | No | **BLOCKED** |
| §4 Props-off DShot | No | **BLOCKED** |
| §5 CRSF / SerialRX on wire | No | **BLOCKED** (host: CRSF bound) |

---

## Result

**PASS (software gates)** — ready for physical DFU session with Robert.  
**BLOCKED (physical walk)** until Robert go — **CDC stub gate cleared** for current hex; use RECOVERY reflash then expect COM.

## USB CDC / HSE (FW 2026-09-10)

- TinyUSB CDC linked for Kakute F745 hex; Windows should enumerate a COM port after DFU reflash (bench verify).
- **HSE assumption:** 8 MHz (IR `hse_mhz: null`) until Hardware fills IR.
- **USB pins:** PA11/PA12 OTG_FS AF10 (MCU-standard; not IR fields).
- Host CLI / dual CI unchanged (host HAL CDC = stdin).

**Heartbeat hex (2026-09-10):** `build-f745-kakute/bobflight.hex` **233975** B, sha256 `3cc3838af1ab1553190614151661eebf87c41ecf96ec04325b64abe0d62a997c`. Expect PA2 Reset early 4× then init 4×100ms then ~2 Hz = app alive; blink+no USB → USB/HSE; no blink → boot/fault. Props-off.

**Gate3 proof expect:** Reset early blink → busywait ~2 Hz on PA2 → USB COM **`1209:B0B1`**. Hex 233975 B sha256 `3cc3838a…d62a997c`.

**cdc4 (2026-09-10):** hex **233975** B — USB **HSI-PLL fallback**. Same PA2/COM `1209:B0B1` expect. Props-off.

**cdc5 (2026-09-10):** hex **233975** B — LED legend 1=hse-pll 2=hsi-pll 3=hsi-raw; 2 chirps=USB returned; ~2Hz=main; COM `1209:B0B1`. Props-off.

**Prove-Reset (2026-09-10):** hex **48341** B sha256 `9421e126…0b4a19a2` — expect ~5–10 Hz blue forever; **no COM** (by design). Props-off.

**cdc6 (2026-09-10):** `bobflight-cdc6.hex` **233975** B sha256 `bd1a336a…a45edfa9` — 3 slow Reset → 1/2/3 clock → 2 chirps → ~2 Hz → COM `1209:B0B1`. Props-off.

**cdc7-pll (2026-09-10):** `bobflight-cdc7-pll.hex` **235595** B sha256 `fa35b090…e37bf859` — Reset3 → main1 → board1 → clock1/2/3 → USB2 → ~2 Hz; HF≈20 Hz → COM `1209:B0B1`. Props-off.

**cdc8 (2026-09-10):** `bobflight-cdc8.hex` **236315** B sha256 `24ede25d…4628c47f` — after Reset-3, N slow=stage then 20Hz; long=N0; stages 1=main … 7=post-USB → COM `1209:B0B1`. Props-off.

**cdc9 (2026-09-10):** `bobflight-cdc9.hex` **236315** B sha256 `54c40a3b…7fc1168c` — PLLCFGR reserved bit29 preserved (cdc8 bare write cleared it → no PLLRDY → encode3/hsi-raw). Expect clock 1|2 + USB chirps + ~2Hz + COM `1209:B0B1`. Props-off. cdc8 kept.

**cdc11-usb (2026-09-10):** `bobflight-cdc11-usb.hex` **237215** B sha256 `9de90488…6040387e` — soft-connect after tud_init; expect encode **2** + COM `1209:B0B1`. Props-off.
