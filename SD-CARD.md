# Blackbox SD-card panel and read-only probe

This development change adds an **Onboard SD card** section to the existing Blackbox tab. It is a diagnostic milestone, not a completed flight logger.

## Available now

- **Check SD card** explicitly starts initialization and read-only geometry inspection.
- **Refresh status** reads the current probe result.
- **Cancel probe** stops an outstanding probe.
- The panel reports capacity, FAT32/exFAT hint, partition start, cluster size and error/detail information. These are the last probe results, not continuous card-presence detection.
- Only an explicitly requested probe is polled, at most once per second, for at most 15 seconds. Initialization is not automatically retried.
- Leaving the tab, disconnecting or entering the post-flash gate invalidates pending UI replies and stops status polling. Firmware independently cancels the probe if USB disconnects, arming/motor activity/calibration starts, or bootloader entry is pending.
- USB bench recording and SD-panel operations are mutually excluded in the page. Existing bench JSON/CSV exports are unchanged.

Demo/older firmware is shown as unavailable, never as a successful physical-card test. No check is sent merely by opening the tab.

## Not available yet

**The firmware does not yet create onboard `.bbl` files, list files, or transfer them to the computer.** The download control is explicitly disabled. The existing USB bench JSON/CSV export is not an Explorer flight log.

USB removable-drive mode is also not implemented. That needs a firmware USB mass-storage interface and exclusive ownership of the SD card. A future transition must stop and finalize logging before exposing the card, exclude flight operation while the computer owns it, and require safe eject before returning control. Read-only export should be the initial design, avoiding host filesystem writes. There is no mass-storage command behind this panel.

The original binary encoder and bounded capture FIFO are groundwork. Earlier standalone C-encoder tests decoded 600 synthetic samples in Explorer with no corrupt frames. This does not demonstrate controller recording or complete Explorer UI semantics: BobFlight logs must not be falsely identified as Betaflight; legacy-computed setpoint/error graphs are not reliable for this format. Direct setpoint and `bobflightError` fields carry the intended values.

## Firmware behavior

Commands: `sd probe`, `sd status`, `sd cancel`. Every reply ends with `sd_end: 1`.

The start guard requires disarmed state, no motor test, no calibration, USB connected, no pending bootloader entry and no already-running probe. The board must provide a supported SD capability and a high-resolution clock.

Kakute F745 uses its SD SPI1 separately from gyro SPI4. Initialization is GPIO-clocked with at least 3 microseconds per half-cycle, because 108 MHz PCLK2 divided by 256 would exceed the SD initialization limit. Normal transfers use SPI1 at 13.5 MHz for that clock configuration. Exchanges yield while pending; the control loop contains no SD wait loop. Physical timing/throughput has not been measured.

The probe supports SDHC/SDXC initialization, sector-zero or one supported primary MBR partition, and structurally plausible 512-byte FAT32/exFAT geometry. GPT, multiple candidate partitions, malformed geometry and out-of-range sectors fail explicitly. Recognition is **not** a mount, health check, boot-region checksum validation, repair or filesystem-write capability. No formatting, erasing or SD sector-writing API is exposed by the diagnostic.

The transport also contains mock-tested single-sector write groundwork, but no application command calls it. The linked read-only probe image excludes `sd_spi_begin_write` through section garbage collection. No flight-control equations, normal arming/failsafe policies or persistent configuration schema are changed. PID tracing defaults off.

## Bounded checks

Native regression suite: run the Debug CMake host build and CTest. Added tests cover FIFO/timestamp/drop behavior, original binary encoding, bit-exact PID trace comparison, SD protocol/CRC/bounds/delayed response, hardware-register mocks, read-only filesystem probing and CLI guards.

Configurator:

```text
npm ci --no-audit --no-fund
npm run build
npm --prefix protocol run test:sd
npm --prefix ui run test:sd
node ui/scripts/test-blackbox.cjs
```

The SD-panel model tests cover explicit start, serialization, bounded status polling, stale reply invalidation, malformed replies, unavailable firmware/demo mode, cancellation and disconnection. These are automated checks, not hardware evidence.

## Installation and physical probe

Use the single-image build and backup/DFU/recovery procedure in [MAIN-BUILD.md](MAIN-BUILD.md). Expected Kakute version suffix: `-sdprobe1`. Build firmware and configurator from this same branch. This change does not require a different bench/flight build profile.

Before flashing, remove propellers, disconnect motor power, leave ARM inactive, back up `diff all` and `dump all`, retain the previous known-working image, and verify an independent recovery route. Preserve configuration flash. Use the existing guarded `bl` flow only with saved configuration; do not use `bl discard` to bypass unsaved changes or mass-erase configuration storage.

After reconnecting, verify version, board identity, `storage` and saved configuration against the backup. In Blackbox, click **Check SD card** once. Expect a completed probe, roughly the card's marketed capacity, and a filesystem hint; keep the raw reply. A refusal/error is not a reason to format the card or bypass a guard. Stop on unexpected motor activity, reset, lost configuration or unreliable USB. No arming or flight test is required for this diagnostic.

The next implementation milestone is safe filesystem-backed file creation and recording, then verified file retrieval. It remains unfinished.
