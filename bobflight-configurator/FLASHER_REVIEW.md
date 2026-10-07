# Guarded local-HEX flashing workflow

This configurator-only change does not enable F4/H7 backends, change arming/failsafe behavior, or qualify any board for flight. No firmware rebuild or hardware flash is needed to review the UI. Existing target capabilities remain authoritative; a catalog entry is not hardware support.

## Install for review (PowerShell, from repository root)

Use Node.js 20 or newer. Keep your working tree clean; do not discard local changes.

```powershell
if (git status --porcelain) { throw "Working tree has changes. Commit or stash them before switching." }
git fetch origin
if ($LASTEXITCODE -ne 0) { throw "Fetch failed" }
git switch feat/flasher-user-journey
if ($LASTEXITCODE -ne 0) { throw "Branch switch failed" }
git pull --ff-only origin feat/flasher-user-journey
if ($LASTEXITCODE -ne 0) { throw "Branch update failed" }
Set-Location bobflight-configurator
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Install failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
npm run dev
```

Open the localhost address printed by Vite on the computer attached to the controller. Real USB needs a supported Chrome/Edge secure context. A remote preview cannot access a controller attached to a different computer.

## Review without hardware

- Initial target is empty and Demo is off. Flash stays disabled until all required checks pass.
- Select a supported target and inspect its capability label. Sensor-only means no motor output.
- Use Demo only explicitly. A successful simulation says MOCK ONLY and must not clear a pending live-flash recovery gate.
- Move between Flasher and Connect: selection and file state stay intact. Navigation is blocked while flashing settles.
- Malformed, overlapping, oversized, wrong-target or out-of-window HEX files are refused. Filename hints and generic ST USB identifiers are not proof of board identity.
- Cancel stays busy until the operation settles. Failed or cancelled live operations retain the gate and require fresh device selection before retry.

## Seven-stage live sequence (not hardware-verified by these tests)

1. Remove props, disconnect the flight battery, save any readable `diff all` backup using the currently installed firmware's configurator, and establish independent recovery. Acknowledge explicitly if no readable backup exists.
2. Select the exact supported board. The user must verify the physical board; 0483:DF11 identifies ST ROM DFU, not its board model.
3. Load that board's application HEX, not BIN, diagnostics or reset-test images. Current accepted F7 images follow the existing 512 KiB application-window and vector policies. These are not universal future-target policies.
4. If the running BobFlight firmware is reachable, request `bl` through its guarded CLI. Review any refusal; do not automatically save, discard or retry. Confirm actual DFU enumeration separately. Disconnect CDC before DFU selection.
5. Select the ST DFU device and reconfirm the physical board/image match. USB detach or target changes invalidate the selection/acknowledgement.
6. Flash, wait for sector erase, programming and readback verification. Do not unplug or close the page. No automatic full-chip erase is implied; settings may persist, migrate or reset.
7. Reconnect the real CDC port, not a mock port. Fresh live version and expected board identity are required to unlock configuration. This is not cryptographic firmware authentication or flight qualification. Inspect settings and restore only compatible values; use deliberate `save` where the board supports nonvolatile storage, then verify persistence after reboot. There is no automatic restore/save.

## Stop and recovery conditions

Stop on a target mismatch, refused CLI command, failed erase/program/readback, missing CDC identity, or unexpected settings. Check actual USB state before any deliberate retry. On Windows, driver changes apply only to the verified STM32 BOOTLOADER interface, never an unrelated COM/device interface.

Software `bl` requires working firmware and USB. It cannot recover failed startup. For a board with broken/inaccessible BOOT, establish documented usable BOOT pads or a proven SWD recovery route before experimental flashing. Physical `bl`, DFU writes, reconnect and persistence still require target-board verification; simulations do not establish them.

## Automated checks

```powershell
npm run targets:check
npm run typecheck
npm --prefix protocol run test:hex-validation
npm --prefix protocol run test:dfu
npm --prefix protocol run test:bootloader
npm --prefix protocol run smoke:webserial
npm --prefix ui run test:targets
npm --prefix ui run test:firmware-validation
npm --prefix ui run test:flasher-journey
npm --prefix ui run test:post-flash
npm --prefix ui run test:transport-identity
npm run build
```

These tests exercise parser boundaries, simulated DFU, actual component handlers/provider guards, and production-adapter mock routing. They do not write hardware. No merge or hardware qualification is implied by this PR.
