# BobFlight Firmware Flasher (WebUSB DFU)

Clean-room TypeScript flasher for BobFlight Configurator.
**Apache-2.0** — Copyright 2026 Robert Leclercq.

Path B: original code from public USB DFU 1.1 + ST DfuSe / AN3156 knowledge only.
**Never** paste Betaflight Configurator / MSP / GPL flasher sources.

## DFU ≠ CDC CLI

| Path | Module | Role |
|------|--------|------|
| **ST ROM USB DFU** | `src/flasher/*` | Firmware write via WebUSB (BOOT0 / DFU pad) |
| **USB CDC CLI** | `client.ts`, `web-serial.ts`, … | Runtime config after the app boots |

There are **no CLI flash hooks** (`FLASH_CAPABILITIES.supportsCliFlash === false`).
Flash only through ST ROM DFU + WebUSB. After **leave**, the board enumerates as CDC; use CLI `status` / `version` for identity (`board:` field). Do **not** hardcode Betaflight VID/PID for CDC.

## LOCKED flash path (FW Lead)

Host equivalent:

```text
dfu-util -a 0 -s 0x08000000:leave -D bobflight.hex
```

| Constant | Value | Notes |
|----------|-------|--------|
| VID | `0x0483` | ST Microelectronics ROM DFU |
| PID | `0xDF11` | STM32 DFU |
| Alternate | `0` | Main flash (`dfu-util -a 0`) |
| Flash base | `0x08000000` | STM32 mapped flash |
| Leave | yes (default) | Jump to application after write |

Artifact reference (primary):  
`/workspace/bobflight-firmware/build-f745-kakute/bobflight.hex`

### Boards / MCU gate

| Board (`status` `board:`) | MCU | Flash size gate |
|---------------------------|-----|-----------------|
| `kakute_f7_hdv` (primary) | **F745** | 1 MiB |
| `tmotor_f7_v2` (secondary) | **F722** | 512 KiB |

Pass `FlashOptions.expectedMcu` (`"F745"` \| `"F722"`) and/or tag firmware via `parseFirmware(..., { mcu })`.
**NEVER** flash an F722 image onto an F745 (or the reverse) — the gate refuses mismatches and oversized images.

## Safety

- **Props off** before entering DFU / connecting USB for flash.
- DFU path does **not** arm motors; there is no arm command in the flasher.
- After leave → CDC: **refuse configuration UI** until `version` and `status` succeed and look sane (`board:`, fail-closed gates as documented for CLI).
- Use MockFlasher in CI; live flash needs Chrome/Edge + device in ST ROM DFU.

## Usage (sketch)

```ts
import {
  createFlasher,
  parseFirmware,
  FLASH_CAPABILITIES,
  ST_DFU_VID,
  ST_DFU_PID,
} from "@bobflight/protocol";

// CI
const mock = createFlasher("mock");
mock.onProgress((p) => console.log(p.phase, p.bytesWritten));
await mock.flash(await parseFirmware(hexText, { mcu: "F745" }), {
  expectedMcu: "F745",
  leave: true,
});

// Browser (user gesture)
const dfu = createFlasher("webusb-dfu");
await dfu.requestDevice?.(); // filter 0x0483/0xDF11
await dfu.flash(parsed, { expectedMcu: "F745", leave: true });
```

## Windows WebUSB "Access denied" on open()

`requestDevice` can succeed (picker shows STM32 BOOTLOADER) while `device.open()` still throws **Access denied**.

Common causes:
1. **WinUSB not bound** — Chrome WebUSB needs **WinUSB** via Zadig (not libusb0/libusbK alone). Options → List All Devices → STM32 BOOTLOADER → WinUSB → Replace Driver.
2. **Device busy** — close `dfu-util`, other Configurator/Chrome tabs, STM32CubeProgrammer; unplug/replug DFU.
3. **Wrong mode** — must be ST **ROM DFU** (0483:df11), not CDC runtime. Leave CDC before DFU.
4. ST ROM DFU is typically a **single** DFU interface (not a CDC+DFU composite). Composite Access denied usually means a non-WinUSB interface is blocking open.

Debug: `chrome://device-log` after the failure.

## Live DFU readiness

- **Node**: WebUSB path throws `browser secure context required` (same idea as Web Serial).
- **Browser**: Chrome/Edge, HTTPS or localhost, board in ST ROM DFU (BOOT0/DFU pad).
- Kakute dry-run with system tool: `dfu-util -a 0 -s 0x08000000:leave -D bobflight.hex`

## Open FW questions

1. Confirm no custom DFU bootloader — **ST ROM only** (Lead locked; still verify on kakute_f7_hdv hardware).
2. Per-page erase vs mass erase behavior on F745 ROM for large images.
3. Optional upload-verify before leave (MVP may skip full UPLOAD compare).
4. CDC identity after leave: rely on `status` `board:` — confirm exact strings for kakute_f7_hdv / tmotor_f7_v2.
