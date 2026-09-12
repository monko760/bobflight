# Bring-up — Holybro Kakute F7 HDV (primary flash)

> **cdc6 FULL USB hex ready (2026-09-10 PT):** `build-f745-kakute/bobflight.hex` (+ copy `bobflight-cdc6.hex`). Prove-Reset PASSED (continuous blue blink); resume full app with `-DBOBFLIGHT_PROVE_RESET=OFF`. Boot: 3 slow Reset blinks → clock encode → 2 chirps → ~2 Hz. Props-off recovery reflash — see [`RECOVERY-DFU-KAKUTE-F7-HDV.md`](./RECOVERY-DFU-KAKUTE-F7-HDV.md).

**PM priority:** this is the **primary** first-flash board.  
**Secondary:** T-Motor F7 V2 — [`BRINGUP-F7-V2.md`](./BRINGUP-F7-V2.md) (STM32F722).

**Board IR (canonical):** `/workspace/board-defs/holybro/kakute_f7_hdv.yaml`  
**board_id:** `kakute_f7_hdv`  
**MCU (IR):** `mcu.family: STM32F745` (**not** F722)  
**IR status:** `meta.status: bf-derived` (not bench-verified)  
**Bench checklist (Hardware):** `/workspace/board-defs/holybro/kakute/BENCH-CHECKLIST-KAKUTE-F7-HDV.md`  
**Dual-check:** `/workspace/board-defs/holybro/kakute_f7_hdv.DUALCHECK.md`  
**NOTICE (GPL / bf-derived boundary):** `/workspace/board-defs/holybro/NOTICE-BF-DERIVED-IR.md`  
**Dry-run:** [`BRINGUP-KAKUTE-F7-HDV-DRYRUN.md`](./BRINGUP-KAKUTE-F7-HDV-DRYRUN.md) (software PASS 2026-09-05 PT).
**Recovery (no COM / reflash):** [`RECOVERY-DFU-KAKUTE-F7-HDV.md`](./RECOVERY-DFU-KAKUTE-F7-HDV.md)

Do **not** invent silkscreen labels. Pin names below are quoted from the owned IR only.  
Do **not** paste Betaflight `config.h` / BF source. No vendor outreach from this checklist.

Sibling path `holybro/kakute/holybro_kakute_f7_hdv.yaml` is **superseded** (`kakute/_superseded/`); prefer PM slug `kakute_f7_hdv`.

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
| Attribution | Betaflight target KAKUTEF7HDV / HBRO (`license.attribution`) |
| Provenance | `meta.provenance: betaflight-target-derived` |
| Clean-room | **No** — exception scoped to this board IR (+ tmotor_f7_v2 per IR notes) |
| Bench-verified | **No** — `meta.status` is `bf-derived`, not `verified` |
| Gyro chip | IR `gyro.chip: MPU6000` (confirm package marking on bench) |
| HSE | IR `mcu.hse_mhz: null` — **FW assumes 8 MHz** (PX4 holybro/kakutef7 board.h + BF STM32F745 default); confirm on bench before golden |
| MCU | IR `mcu.family: STM32F745` — **F745, not F722** |

See also: `holybro/NOTICE-BF-DERIVED-IR.md`, `holybro/kakute/NOTICE-BF-DERIVED-IR.md`, `LICENSE.GPL` under `board-defs/holybro/`.

---

## IR fields used in this checklist (quote-only)

**Gyro (SPI)** — from IR `gyro.*`:

| Field | IR value |
|-------|----------|
| `chip` | `MPU6000` |
| `spi_bus` | `4` |
| `cs_pin` | `PE4` |
| `exti_pin` | `PE1` |
| `align` | `CW270_DEG` |
| `spi_pins.sck` | `PE2` |
| `spi_pins.miso` | `PE5` |
| `spi_pins.mosi` | `PE6` |

**Motors M1–M6** — from IR `motors.channels[]` + `protocol_default: DShot600`  
(IR note: timer/channel are AF interpretations — verify on first DShot; dual-check flags AF caveat.)

| index | pin | timer | channel | dma_opt |
|-------|-----|-------|---------|---------|
| 1 | PB0 | TIM3 | 3 | 0 |
| 2 | PB1 | TIM3 | 4 | 0 |
| 3 | PE9 | TIM1 | 1 | 2 |
| 4 | PE11 | TIM1 | 2 | 1 |
| 5 | PC9 | TIM8 | 4 | 0 |
| 6 | PA3 | TIM2 | 4 | 0 |

**Serial RX** — from IR `uart.serial_rx`:

| Field | IR value |
|-------|----------|
| `uart` | `3` |
| `pins.tx` | `PB10` |
| `pins.rx` | `PB11` |
| `protocol_default` | `CRSF` |

(IR comment: `RX_PPM_PIN` PE13 / UART7_RX PE7 often used for HD/serial RX — MVP uses SerialRX UART3 as above; PE13 is `deferred.rx_ppm_pin`.)

**USB** — IR `usb.enable_cdc: true`.

**USB pins (MCU-standard, not in IR):** STM32F745 OTG_FS **PA11 (DM) / PA12 (DP)**, AF10. IR has no USB pin fields — documented here for bring-up.

**USB clock / detect:** Public pin **USB_DETECT PA8** (VBUS sense). FW forces software B-valid (`vbus_sensing=false`). HSE→PLLQ 48 MHz preferred; **HSI→PLL fallback** (PLLM=16, N=432, Q=9) if HSE fails — Device Manager stays silent without 48 MHz. CLI `usb_clk:` reports `hse-pll` / `hsi-pll` / `hsi-raw`. **Boot LED (no DM):** **Reset** = 3 slow early blinks (~250 ms half-period, both edges, then LED on) in `Reset_Handler` before main; then clock code 1=`hse-pll`, 2=`hsi-pll`, 3=`hsi-raw`, 5=unknown (~200 ms on/off, then 1 s on); then **2 fast chirps** = USB init returned (OTG skipped on `hsi-raw`; TinyUSB GRSTCTL waits bounded); then main ~2 Hz toggle = loop alive.

**Deferred (not first-flight MVP)** — IR `deferred.*`: beeper `PD15`, led0 `PA2`, led_strip `PD12`, rx_ppm `PE13`.

---

## Firmware CMake / target status

| Item | Status |
|------|--------|
| `BOBFLIGHT_BOARD=kakute_f7_hdv` | Supported |
| Toolchain | `cmake/stm32f745.cmake` + `stm32f745.ld` + shared `startup_stm32f722.c` (F7 vector + OTG_FS) |
| USB CDC | TinyUSB 0.21.0 (MIT) — OTG_FS PA11/PA12, software VBUS; HSE→PLL or **HSI→PLL** **48 MHz USB** |
| HSE | IR null → **assume 8 MHz** (PX4 kakutef7 + BF F745 default); `hal_clock_init(8)`; HSI-PLL fallback on HSE fail |
| Hex | `build-f745-kakute/bobflight.hex` |

### Rebuild (MCU)

```
cmake -S . -B build-f745-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv \
  -DBOBFLIGHT_PROVE_RESET=OFF
cmake --build build-f745-kakute
```

---

## 0. Prep (host / CI) — when board lands in CMake

- [ ] Point IR at canonical YAML: `/workspace/board-defs/holybro/kakute_f7_hdv.yaml`
- [ ] Codegen (once path wired):  
      `python3 scripts/ir_codegen.py <path-to-kakute_f7_hdv.yaml> -o src/board/pins_generated.h`  
      (or `-DBOBFLIGHT_BOARD=kakute_f7_hdv` once FW Lead lands the CMake switch)
- [ ] Host smoke after select: `BOARD=kakute_f7_hdv ./scripts/test_host_cli.sh` (when matrix includes Kakute)
- [ ] **F745** image (not F722): toolchain + linker + startup for STM32F745 — **BLOCKED today**  
      Placeholder once landed (names illustrative; FW Lead owns real paths):  
      `cmake -S . -B build-f745 -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake -DBOBFLIGHT_HOST_SMOKE=OFF -DBOBFLIGHT_BOARD=kakute_f7_hdv`  
      `cmake --build build-f745` → `build-f745/bobflight.{elf,hex,bin}`

**Pass:** host contract for `kakute_f7_hdv` + F745 `bobflight.elf`/`hex`.  
**Fail:** CMake rejects board id; only F722 toolchain; missing hex.

---

## 1. DFU → flash

- [ ] Enter STM32 DFU (BOOT0 / board DFU path per Hardware photos — no invented silk here)
- [ ] Flash **F745** `bobflight.bin` / `.hex` via `dfu-util` (or equivalent) — **requires FW Lead hex**
- [ ] Power-cycle / leave DFU

**Pass:** DFU enumerates; flash completes without error; board reboots to app.  
**Fail:** no DFU device; verify-failed; brown-out; wrong MCU image (do **not** flash F722 hex onto F745).

**Open:** host `dfu-util` / udev as needed on the bring-up machine.

---

## 2. USB CDC CLI

> **CDC gate (2026-09-10 PT):** Stub-era flash left no COM. **cdc6 FULL USB hex:** `build-f745-kakute/bobflight.hex` / `bobflight-cdc6.hex` (`BOBFLIGHT_PROVE_RESET=OFF`). Stub gate **cleared**. Props-off reflash via [`RECOVERY-DFU-KAKUTE-F7-HDV.md`](./RECOVERY-DFU-KAKUTE-F7-HDV.md), then expect CDC COM. No invented pins.

- [ ] USB cable; CDC ACM enumerates (`usb.enable_cdc: true` in IR) — expect after CDC-fixed reflash
- [ ] Open serial; expect ready banner + CLI
- [ ] `help` → command list
- [ ] `version` → BobFlight version string
- [ ] `status` → expect (host-equivalent contract on MCU when wired):
  - `board: kakute_f7_hdv`
  - `ir: bf-derived`
  - `gyro_ok: no` until whoami lands
  - `dshot_bound:` consistent with bound motor count from IR (6 channels in YAML)
  - `rx: CRSF bound` when UART3 IR packs
  - `mmio: allowed (bf-derived)`
  - **no** pin tokens (`PEx` / `PAx`) and **no** “betaflight” string in CLI

**Pass:** CDC up; status board id + bf-derived IR; no pin/BF leaks.  
**Fail:** no CDC after CDC-fixed reflash (escalate FW Lead); wrong `board:`; pin or BF string leak.

---

## 3. Gyro whoami

- [ ] Props still **OFF**
- [ ] SPI4 + CS `PE4` + EXTI `PE1` + SCK/MISO/MOSI `PE2`/`PE5`/`PE6` (IR) — driver whoami when implemented
- [ ] Expect IR `gyro.chip: MPU6000`; confirm package marking on bench (Hardware checklist)
- [ ] `status` → `gyro_ok: yes` only after a real whoami match

**Pass:** whoami matches MPU6000 (or updated IR after bench); gyro bind healthy.  
**Fail:** SPI timeout; unexpected whoami; do not arm.

---

## 4. Props-off DShot (M1–M6)

- [ ] Confirm **props removed**
- [ ] Protocol intent: IR `motors.protocol_default: DShot600`
- [ ] Bind uses IR pins/timers above; start with M1–M4 spot-check (bench checklist), then M5–M6
- [ ] Timer AF caveat: dual-check says channels are F745 AF interpretations — verify on first DShot
- [ ] Idle / disarm: no motor spin; optional ESC beep acknowledge only
- [ ] Do **not** arm for this step unless procedure explicitly requires it with props off and gyro healthy

**Pass:** DShot bound per IR channels; ESCs acknowledge idle; **no rotation**.  
**Fail:** missing bind; unexpected spin → power cut immediately.

---

## 5. CRSF / SerialRX

- [ ] Wire RX to IR SerialRX: UART `3`, TX `PB10`, RX `PB11`, protocol `CRSF`
- [ ] Transmitter on; link up
- [ ] `status` → `rx: CRSF bound` (and frame freshness when RX path is live)
- [ ] Failsafe: TX off → failsafe asserts; motors stay safe

**Pass:** CRSF frames accepted on UART3 pins from IR; failsafe on loss.  
**Fail:** unbound UART; no frames; failsafe silent.

---

## 6. Hand-off

1. Record PASS/FAIL per step with date.  
2. Point Hardware at `BENCH-CHECKLIST-KAKUTE-F7-HDV.md` to move IR toward `verified`.  
3. Do not promote IR to Apache pin facts; keep GPL boundary in YAML / generated header comments.  
4. Do not create software dry-run doc until F745 hex exists.  
5. Keep F7 V2 bring-up secondary: [`BRINGUP-F7-V2.md`](./BRINGUP-F7-V2.md).

---

## Blockers (FW Lead / Hardware / dry-run)

| Blocker | Owner | Notes |
|---------|-------|-------|
| `kakute_f7_hdv` not in `BOBFLIGHT_BOARD` | FW Lead | CMake FATAL on unknown id today |
| No STM32F745 toolchain / ld / startup | FW Lead | Only `stm32f722.*` in tree |
| F745 HAL completeness | FW Lead | Shared `stm32f7/` stubs ≠ F745 target |
| Kakute / F745 **hex missing** | FW Lead | Blocks DFU step + dry-run |
| Dry-run doc deferred | PM / FW | Wait for hex; no `*-DRYRUN.md` yet |
| `dfu-util` / host DFU path | Bring-up host | Confirm when hex ready |
| IR remains bf-derived | Hardware | Bench checklist → `verified` |
| Motor timer AF dual-check caveat | FW + Hardware | Verify on first DShot |
