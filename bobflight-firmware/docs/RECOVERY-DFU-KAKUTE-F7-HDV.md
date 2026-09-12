# Recovery DFU — Kakute F7 HDV (no COM / reflash)

**Context (2026-09-10 PT):** Board was DFU-flashed with stub-era `kakute_f7_hdv` (STM32F745) → **no COM / CDC** after leave.  
**Root cause (FW Lead):** MCU USB CDC HAL was a **stub**. **CDC-fixed artifact now landed** (same path, larger image).  
**Do not ping Robert** — props-off reflash walk when he goes / PM confirms.

**Parent:** [`BRINGUP-KAKUTE-F7-HDV.md`](./BRINGUP-KAKUTE-F7-HDV.md)  
**Dry-run:** [`BRINGUP-KAKUTE-F7-HDV-DRYRUN.md`](./BRINGUP-KAKUTE-F7-HDV-DRYRUN.md)  
**board_id:** `kakute_f7_hdv` · **MCU:** STM32F745 · **IR:** bf-derived (GPL pin facts; `.c` Apache-2.0)

---

## Symptom → recovery

| Observation | Meaning |
|-------------|---------|
| Prior flash left no CDC COM | Stub-era USB CDC HAL |
| Board still recoverable | STM32 ROM DFU via BOOT0 / DFU button (no COM needed) |
| CDC-fixed hex ready | Reflash with artifact below; **expect COM** after leave |

**Do not** power-cycle the stub image hoping for COM. Force DFU and reflash.

---

## Safety

- **Props OFF** before any power, USB, or DFU.
- Do **not** flash an F722 image onto this F745 board.
- Confirm size **237215** + sha256 `9de90488…6040387e` before `-D` (cdc11-usb soft-connect; reject older).

---

## Current flash artifact — cdc11-usb (verified 2026-09-10 23:24 UTC)

| Item | Value |
|------|-------|
| Preferred hex | `/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc11-usb.hex` |
| Also present | `bobflight.hex` / `bobflight-cdc11.hex` (same sha256 this build) |
| Size | **237215** bytes |
| sha256 | `9de904889b90ae42edaaa876815833b0b20a88c80c15f23c0c5ae1106040387e` |
| Change | **Soft-connect after `tud_init`** |
| Prior (do not use) | cdc9 236315 (`54c40a3b…`); cdc8 `24ede25d…`; Prove-Reset 48341 |


## Recovery procedure

### 1. Host tools

```bash
dfu-util --version    # shared box: dfu-util 0.11
```

### 2. Force ROM DFU (no COM required)

1. Props OFF.  
2. Enter STM32 DFU via BOOT0 / board DFU path (Hardware photos — **no invented silk**).  
3. USB connect; `dfu-util -l` → STM32 BOOTLOADER.

### 3. Reflash (verified recipe)

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc11-usb.hex
ls -la "$HEX"   # expect 237215
sha256sum "$HEX"  # expect 9de904889b90ae42…6040387e
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
```

Bin equivalent:

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f745-kakute/bobflight.bin
```

**Pass:** download + leave without error.  
**Fail:** verify-failed / wrong size — stop; escalate FW Lead.

### 4. Post-flash gate

1. Leave DFU into app.  
2. **Expect USB CDC COM** to enumerate.  
3. Continue [`BRINGUP-KAKUTE-F7-HDV.md`](./BRINGUP-KAKUTE-F7-HDV.md) §2 (`help` / `version` / `status` → `board: kakute_f7_hdv`).

| Result | Action |
|--------|--------|
| COM + CLI | **PASS** recovery — resume whoami → DShot props-off → CRSF |
| Still no COM | Capture `dfu-util -l`, USB logs → FW Lead |
| COM but no banner | Port OK; CLI/init → FW Lead |

---

## Checklist

- [ ] Props OFF  
- [ ] Hex size **237215** + sha256 `9de90488…6040387e` confirmed (cdc11-usb)
- [ ] `dfu-util -l` shows STM32 DFU  
- [ ] `dfu-util -a 0 -s 0x08000000:leave -D …/bobflight.hex` completes  
- [ ] Prove-Reset: blue **~5–10 Hz** forever (COM **not** expected)
- [ ] CDC builds only: COM **`1209:B0B1`** / `ttyACM*`  
- [ ] CLI `help` / `status` → `board: kakute_f7_hdv`  

---


---

## Field update — still no COM after CDC-fixed hex (2026-09-10 PT)

CDC-fixed artifact (**226926** B) was flashed; **COM still absent**. Do **not** ping Robert. Capture the following for FW Lead before another reflash cycle.


### Robert field notes (2026-09-10 PT)

| Observation | Note |
|-------------|------|
| DFU | **OK** — ROM DFU path works; reflash possible |
| LED | **Solid** (not flashing) after leave / app boot |
| USB CDC COM | **None** — still no COM after CDC-fixed hex |

Interpretation for FW Lead: boot/app appears stuck or idle (solid LED), USB device not enumerating as CDC ACM. DFU recovery path remains healthy — not a brick. Capture bundle in §D still applies; add LED behavior to the package.



### cdc11-usb expect (soft-connect after tud_init)

After props-off DFU + leave (`bobflight-cdc11-usb.hex` / sha256 `9de90488…`):

| Observation | Meaning |
|-------------|---------|
| Encode / clock **2** (hsi-pll) | **Expected** success path for this build |
| Soft-connect after `tud_init` | USB attach sequencing fix (FW Lead) |
| USB **`1209:B0B1`** | CDC COM success |

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc11-usb.hex
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
lsusb | grep -i 1209 || true
```

Props-off mandatory.

### cdc9 expect (PLLCFGR bit29 fix) (prior)

After props-off DFU + leave (`bobflight-cdc9.hex` / sha256 `54c40a3b…`):

| Observation | Meaning |
|-------------|---------|
| Clock path **1** (hse-pll) or **2** (hsi-pll) | **PASS** path for this build |
| Clock path **3** (hsi-raw) | **Unexpected** after bit29 fix — report to FW Lead |
| then HF stages / ~2 Hz as prior | App progressing |
| USB **`1209:B0B1`** | CDC COM success |

cdc8 HF stage encode (Reset-3 → N slow + 20Hz; long=N0; 1=main…7=post-USB) may still apply for hang localization — but **success criteria for cdc9** is **clock 1|2 (not 3)** + **USB chirps** + **~2 Hz** + COM `1209:B0B1`.

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc9.hex
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
lsusb | grep -i 1209 || true
```

Props-off mandatory.

### cdc8 HF stage legend + COM expect (prior)

After props-off DFU + leave (`bobflight-cdc8.hex` / sha256 `24ede25d…`):

1. **Reset-3** — three slow blinks (reset marker).  
2. **HF encode:** **N slow blinks** = stage number **N**, then **~20 Hz** burst confirming that stage.  
3. **Long blink** = **N0** (stage zero / idle marker per FW Lead).  
4. Continue through stages; then expect COM **`1209:B0B1`** if USB path completes.

| Stage N | Meaning (FW Lead) |
|---------|-------------------|
| 1 | main |
| 2 | (next — record as observed) |
| 3 | (next — record as observed) |
| 4 | (next — record as observed) |
| 5 | (next — record as observed) |
| 6 | (next — record as observed) |
| 7 | **post-USB** |

If LED sticks at stage **k** (N=k slow then 20 Hz repeating, never advances): fault/hang after that stage. Props-off mandatory.

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc9.hex
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
lsusb | grep -i 1209 || true
```

### cdc7-pll LED legend + COM expect (prior)

After props-off DFU + leave (`bobflight-cdc7-pll.hex` / sha256 `fa35b090…`):

| Pattern | Meaning |
|---------|---------|
| **Reset3** (3 slow) | Reset marker |
| **main1** (1 short) | Main/stage marker |
| **board1** (1 short) | Board marker |
| **clock 1/2/3** | USB clock: hse-pll / hsi-pll / hsi-raw |
| **USB2** (2 chirps) | USB returned |
| **~2 Hz** | Main loop heartbeat |
| **HF ≈ 20 Hz** | High-frequency activity marker |
| USB **`1209:B0B1`** | CDC COM success |

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc7-pll.hex
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
lsusb | grep -i 1209 || true
```

Props-off mandatory.


### cdc6 LED legend + COM expect (prior)

After props-off DFU + leave (`bobflight-cdc6.hex` / sha256 `bd1a336a…`):

| Pattern | Meaning |
|---------|---------|
| **3 slow** blinks | **Reset** path marker |
| then **1 / 2 / 3** | USB clock: **hse-pll** / **hsi-pll** / **hsi-raw** |
| then **2 chirps** | USB stack **returned** |
| then **~2 Hz** | **Main** loop running |
| USB **`1209:B0B1`** | CDC COM success |

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight-cdc6.hex
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
lsusb | grep -i 1209 || true
```

Props-off mandatory. Prove-Reset (48341 B, ~5–10 Hz, no COM) is a different gate — do not mix expects.

### Prove-Reset expect (this hex)

**Not a CDC proof.** After props-off DFU + leave:

| Observation | Meaning |
|-------------|---------|
| Blue LED **~5–10 Hz forever** | **PASS** — Reset/app + LED path alive |
| Solid / dark / no blink | **FAIL** — still boot/fault (same class as prior solid-LED field) |
| **No COM** / no `1209:B0B1` | **Expected** — do not chase USB on this artifact |
| DFU still works | Board recoverable for next CDC hex |

Flash recipe unchanged:

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
```

### PA2 LED legend (cdc5 — prior CDC builds) + COM expect

FW Lead cdc5 field decode after props-off reflash + leave (**233975** B / sha256 `3cc3838a…`):

| PA2 pattern | Meaning |
|-------------|---------|
| **1** blink (group) | USB clock path **hse-pll** |
| **2** blinks | USB clock path **hsi-pll** |
| **3** blinks | USB clock path **hsi-raw** |
| **2 chirps** | USB stack **returned** / came up |
| **~2 Hz** steady | **Main** loop running (app alive) |
| No blink / solid | Boot/fault — app not reaching heartbeat |
| USB **`1209:B0B1`** | CDC COM success |

```bash
lsusb | grep -i 1209 || true
ls -l /dev/ttyACM* 2>/dev/null || true
```

Record blink-count (1/2/3), whether 2 chirps occurred, then ~2 Hz, then COM. Props-off mandatory.


### A. Confirm the image that was actually programmed

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
ls -la "$HEX"                 # must be 226926 — not ~122959 stub-era
sha256sum "$HEX" | tee /tmp/bobflight-kakute-hex.sha256
arm-none-eabi-size /workspace/bobflight-firmware/build-f745-kakute/bobflight.elf
```

If size ≠ 226926, stop — wrong artifact.

### B. USB topology (host)

With board in **app mode** (normal boot, not DFU):

```bash
lsusb
ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
# Linux:
dmesg -T | tail -80
```

With board forced into **ROM DFU**:

```bash
dfu-util -l
lsusb | tee /tmp/bobflight-kakute-dfu-lsusb.txt
```

**Pass signals for DFU path:** STM32 BOOTLOADER in `dfu-util -l`.  
**App-mode hope:** new CDC ACM interface / `ttyACM*` after leave — currently **FAIL** in field.

### C. Reflash discipline

1. Props OFF.  
2. Force DFU (BOOT0) — confirm `dfu-util -l` **before** `-D`.  
3. Flash hex (or bin) and capture full console:

```bash
dfu-util -a 0 -s 0x08000000:leave -D "$HEX" 2>&1 | tee /tmp/bobflight-kakute-dfu-flash.log
```

4. Note whether **leave** succeeded vs stayed in DFU.  
5. Power-cycle once (USB reconnect) with props still OFF; re-check `lsusb` / `ttyACM*`.

Optional A/B: same address with `.bin` if hex leave misbehaves:

```bash
dfu-util -a 0 -s 0x08000000:leave -D /workspace/bobflight-firmware/build-f745-kakute/bobflight.bin 2>&1 | tee /tmp/bobflight-kakute-dfu-bin.log
```

### D. What to send FW Lead (bundle)

| File / fact | Why |
|-------------|-----|
| `ls -la` + `sha256sum` of hex | Prove CDC-fixed image, not stub |
| `/tmp/bobflight-kakute-dfu-flash.log` | Download/leave errors |
| `dfu-util -l` (DFU mode) | ROM DFU healthy |
| `lsusb` app + DFU | VID/PID / class clues |
| `dmesg` tail around plug | Disconnect/enum failures |
| Cable / port / hub notes | Host-side rejects |
| HSE still `0` in IR / status | Clock/USB 48 MHz risk — FW Lead |

### E. Do / don’t

- **Do** keep using recovery DFU — board is not bricked if ROM DFU lists.  
- **Don’t** assume COM will appear without a new FW drop if CDC still broken on silicon.  
- **Don’t** ping Robert; escalate package to FW Lead / PM.


---

## Gate1 follow-up — FPU / poll harden (2026-09-10 PT)

**Symptom:** CDC-fixed hex still produced **no Windows COM** after leave DFU / replug (Gate1 blocked). Solid LED; DFU recovery OK.

**Fixes in this rebuild (verify on silicon):**
1. **FPU enable in `Reset_Handler`** — `SCB->CPACR` CP10/CP11 full access before `main()` (hard-float ABI; first float no longer HardFaults into `Default_Handler`).
2. **PWR Scale1 + over-drive** — already present before 216 MHz PLL (kept).
3. **`NVIC_EnableIRQ(OTG_FS_IRQn)`** after `tusb_init` — already present (kept).
4. **`cli_poll()` every MCU main-loop iteration** — alongside `scheduler_run()` so TinyUSB `tud_task` keeps running even if a slice starves.

**Reflash new hex, then unplug/replug WITHOUT boot (normal app boot, not DFU).** Expect a COM port. If Device Manager shows an unknown USB device with **VID:PID 1209:B0B1**, that is still progress vs nothing (driver/INF may be needed for CDC ACM).

**Artifact (this pass):** hex **227646** B (was 226926), bin 80960, elf text=79048 data=1864 bss=4096. SHA256 `c2459b73d8d3651158392e5231b328e2e26b91ea0c2a0cf995ccdbe26eeb698e`.

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
ls -la "$HEX"   # expect 227646
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
# Then: unplug USB, replug (props OFF, no BOOT0) — look for COM / 1209:B0B1
```

## Gate2 — early LED heartbeat (2026-09-10 PT)

**Why:** Field: DFU OK, LED **solid** (not BF blink), **no COM** after Gate1 hex (227646 B). Need a silicon-side proof the app runs past clock/time init.

**What this hex adds:**
1. IR codegen emits `BOARD_GENERATED_LED0_PIN` from YAML `led0_pin` (Kakute: **PA2** → `HAL_PIN_PACK(0,2)`; dummy stays invalid).
2. **Early boot heartbeat** after `hal_clock_init` + `hal_time_init`, **before USB** — if `board_mmio_permitted()` and LED0 valid: GPIO OUT, ~4× 100 ms on/off, leave on.
3. **Main-loop slow toggle** every 250 ms (~2 Hz) while the cooperative loop is alive.

**Expected after reflash (props OFF, leave DFU / normal app boot):**
| Signal | Expect |
|--------|--------|
| Status LED (PA2) | ~**2–4 Hz** blink if app alive (early burst then ~2 Hz main-loop toggle). Solid-on without blink ⇒ stuck before/at early init or LED path not reached. |
| USB CDC COM | Should enumerate as **VID 0x1209 / PID 0xB0B1**, product **“BobFlight CDC”**. Unknown device with that VID:PID still counts as progress (Windows CDC driver/INF). |
| Still no COM + blinking LED | App alive; focus USB clock/HSE/driver — not a silent hardfault at reset. |
| Solid LED + no COM | Same class as Gate1 — capture DFU/`lsusb` bundle for FW Lead. |

**Residual risks:** IR `hse_mhz` still null (code assumes 8 MHz for Kakute — wrong crystal ⇒ USB 48 MHz off); Windows may need a CDC ACM INF even when 1209:B0B1 appears.

**Artifact (this pass):** hex **228546** B (was 227646 Gate1), bin 81280, elf text=79368 data=1864 bss=4104. SHA256 `6c71e6362c0a62c7a9a019a9e326fd7bb1817c2f343ddf032cc376cb45837481`.

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
ls -la "$HEX"   # expect 228546
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
# Unplug/replug (no BOOT0): watch PA2 blink + COM / 1209:B0B1 “BobFlight CDC”
```

---


## Gate3 — VTOR + IRQ-free blink + USB ASAP (2026-09-10 PT)

**Field after Gate2 hex (228546 B):** still **no COM**, LED **solid** (no 4×100ms, no ~2 Hz). Device Manager empty. DFU still works.

**Hypothesis (primary):** After ST DFU leave, **VTOR left at ROM** → SysTick never hits app `SysTick_Handler` → `hal_delay_ms` waits on `g_ms` forever → `boot_led_heartbeat` hangs with LED ON → **USB init never reached**.

**Fixes in this rebuild:**
1. **`Reset_Handler` sets `SCB->VTOR = 0x08000000`** after BSS / CPACR FPU poke, before main (flash `.isr_vector` origin).
2. **Earliest PA2 toggle in `Reset_Handler`** (after FPU+VTOR, before main): crude GPIOA MMIO — enable GPIOA AHB1, MODER PA2 out, ODR toggle ×4 with NOP busywait. No `board_*` calls. Proves Reset ran even if later init dies.
3. **`boot_led_heartbeat` busywait only** (calibrated from `SystemCoreClock`) — **no `hal_delay_ms` / SysTick**.
4. **USB CDC init ASAP** after clock+time (+ short busywait blink) — before motors/gyro.
5. **`hal_delay_ms`**: if `g_ms` never advances, busywait fallback using `SystemCoreClock`.

**PA2 note:** IR-assumed `deferred.led0` / `BOARD_GENERATED_LED0_PIN` = **PA2** — **not silk-verified**. Keep PA2; do not invent pins.

**Expected after reflash (props OFF, leave DFU / normal app boot):**

| Signal | Meaning |
|--------|---------|
| **Early Reset blink** (4× NOP busywait on PA2) then **init busywait 4×~100ms**, then **~2 Hz** main-loop | App + SysTick alive |
| Blink (any) + **still no COM** | App alive → **USB/HSE** lane |
| **Solid-on** after this hex (VTOR+busywait) | Likely **wrong LED pin** (PA2 ≠ blue silk) **or app not starting** |
| Dark forever | Reset not reached / wrong image / hardfault before early blink |

**Residual risks:** Wrong LED pin (PA2 IR-only); HSE/crystal wrong ⇒ USB 48 MHz off; Windows CDC INF for 1209:B0B1.

**Artifact (this pass):** hex **229806** B (was 228546 Gate2), bin 81728, elf text=79816 data=1864 bss=4104. SHA256 `d305b8690b563751e650fbbe05c32f39c97b2e12103ffef8c29ee652acadcfcc`.

```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
ls -la "$HEX"
sha256sum "$HEX"
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
# Unplug/replug (no BOOT0): watch PA2 early+init blinks + COM / 1209:B0B1
```

---

## cdc4 — USB HSI-PLL fallback (2026-09-10 PT)

FW Lead: USB clock **HSI-PLL fallback** (board HSE still unknown / null in IR). Artifact **231905** B sha256 `0dfc6b9f6d2ae09f3d7295561e7f2a64e148b603987f4fb8c67b721e25f81727`.

Still expect: Reset early blink → busywait ~2 Hz on PA2 → COM **`1209:B0B1`**. Props-off.


## cdc5 — clock-path LED legend (2026-09-10 PT)

Artifact **233975** B sha256 `3cc3838af1ab1553190614151661eebf87c41ecf96ec04325b64abe0d62a997c`.

**Legend:** 1 = hse-pll · 2 = hsi-pll · 3 = hsi-raw · 2 chirps = USB returned · ~2 Hz = main. Then expect COM **`1209:B0B1`**. Props-off.



## cdc6-prove-reset — Reset_Handler-only PA2 blink (2026-09-10 PT)

**Field (cdc5):** ~5s video — green solid + **blue solid entire time**; slow count 0, chirps 0, ~2 Hz 0. Does not match cdc5 legend. Clip-too-short ruled out. Likely: app not executing, wrong image, or blue LED ≠ PA2.

**Goal:** Unmistakable **Reset_Handler-only** PA2 blink so field can prove Reset runs **before** any clock/USB/main.

**CMake:** `-DBOBFLIGHT_PROVE_RESET=ON` → compile def `BOBFLIGHT_PROVE_RESET=1`. Default **OFF** (host/dummy/normal MCU unchanged — early 4× blink + main).

**Behavior when ON:** After FPU+VTOR, GPIOA PA2 output, **infinite** toggle both levels (~5–10 Hz NOP busywait). **Never calls `main()`**. Active-high or active-low still visibly blinks.

| Field signal | Meaning |
|--------------|---------|
| Continuous **~5–10 Hz** blue blink | **Reset + PA2 OK** — this image is running |
| Still **solid** blue (no blink) | Not running this image **or** blue LED ≠ PA2 |
| Dark forever | Reset not reached / wrong flash / hardfault before blink |

**Rebuild:**

```bash
cmake -S . -B build-f745-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv \
  -DBOBFLIGHT_PROVE_RESET=ON
cmake --build build-f745-kakute -j
```

**Artifact (this pass):** hex **48341** B (≠ cdc5 233975), bin 17164, elf text=17152 data=12 bss=1980. SHA256 `9421e126086328fa86bff0a1e531799e8cefa742410de7762a2e699f0b4a19a2`. `nm`: `prove_reset_pa2_forever` present; `--gc-sections` drops unreachable main/USB (expected).


```bash
HEX=/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex
ls -la "$HEX"   # expect 48341
sha256sum "$HEX"  # expect 9421e126…0b4a19a2
dfu-util -a 0 -s 0x08000000:leave -D "$HEX"
# Unplug/replug (no BOOT0): expect continuous ~5–10 Hz blue. Still solid ⇒ not this image or blue≠PA2.
```

Props-off mandatory. Do not expect COM — this build never reaches USB/main.


## Prove-Reset — LED-only app proof (2026-09-10 PT)

Artifact **48341** B sha256 `9421e126086328fa86bff0a1e531799e8cefa742410de7762a2e699f0b4a19a2`.

**Expect:** ~5–10 Hz blue forever. **No COM** (by design). Props-off. Use to split app-dead vs USB-only before returning to cdc5-class images.


## cdc6 — Reset marker + clock legend (2026-09-10 PT)

Preferred: `build-f745-kakute/bobflight-cdc6.hex` **233975** B sha256 `bd1a336aa940fa6caf5a9856a1dd75599f3e5039cfd91ce9f9dfbc96a45edfa9` (same bytes as current `bobflight.hex`).

**Legend:** 3 slow Reset → 1/2/3 clock → 2 chirps → ~2 Hz → COM **`1209:B0B1`**. Props-off.


## cdc8 — HF stage encode (2026-09-10 PT)

Preferred: `build-f745-kakute/bobflight-cdc8.hex` **236315** B sha256 `24ede25dce44937ae3026f10d6af1abec0600b43e558cf3fc2a457fb4628c47f`.

**HF legend:** after Reset-3, **N slow** = stage then **~20 Hz**; **long** = N0. Stages **1=main … 7=post-USB**. Then COM **`1209:B0B1`**. Props-off.


## cdc11-usb — soft-connect after tud_init (2026-09-10 PT)

Preferred: `build-f745-kakute/bobflight-cdc11-usb.hex` **237215** B sha256 `9de904889b90ae42edaaa876815833b0b20a88c80c15f23c0c5ae1106040387e`.

**Expect:** encode **2** + COM **`1209:B0B1`**. Props-off.

## Ownership

| Item | Owner |
|------|--------|
| Real CDC HAL + hex | Drivers / BobFlight FW Lead — **landed** (this artifact) |
| Recovery DFU walk / pass-fail | Bring-up Test |
| Go | Robert / BF FW PM — **do not ping Robert** |

---

## Rebuild reference

```bash
cmake -S . -B build-f745-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv \
  -DBOBFLIGHT_PROVE_RESET=ON
cmake --build build-f745-kakute -j
```

## cdc9 — PLLCFGR bit29 fix (2026-09-10 PT)

Preferred: `build-f745-kakute/bobflight-cdc9.hex` **236315** B sha256 `54c40a3b437cc47ba8b5477b8983b2651600f3b6b420dcd3ea994acb7fc1168c`.

**Bug (cdc8):** bare `RCC->PLLCFGR` field write cleared reserved bit29 (reset `0x24003010` keeps `0x20000000`) → PLLRDY never → encode **3=hsi-raw**, USB skipped, ~2 Hz main.

**Fix:** OR `0x20000000` into PLLCFGR write; longer PLLRDY/SWS timeouts. `BOBFLIGHT_HAVE_CMSIS=1` confirmed. Expect clock **1/2**, then USB COM **`1209:B0B1`**. Props-off. Do not clobber cdc8.

