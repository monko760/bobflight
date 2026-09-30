# Onboard Blackbox SD writer throughput (bbl2)

## Symptom

A physical Kakute F7 HDV log (SD over SPI1, firmware `-bbl1-sdread1`) had 650 encoded frames and 3,731 dropped frames at the nominal 500 Hz, which is 85.2 % loss. `blackbox status` still reported `blackbox_rate_hz: 500` because that value was hardcoded.

## Required throughput

- The default scheduler runs gyro/PID at 1 kHz. Logging at 500 Hz takes every second PID step (`H I interval:2`).
- The encoded frame size is about 62 B with the static fixture and about **70.7 B** with flight-like data (host throughput model).
- 70.7 B × 500 Hz = **34.5 KiB/s**. That is about 69 data sectors/s (one 512 B sector every ~14.5 ms), plus FAT/directory metadata. The model measures 77 sector writes/s in total.
- After initialization SPI1 runs at 13.5 MHz (108 MHz PCLK2 / 8), so a 512 B sector is about 0.3 ms of raw clocking. **The SPI clock was not the bottleneck.** The card-side busy time and the firmware's own pacing were. Single-block CMD24 is kept. At this rate multi-block CMD25 is not needed, and CMD24 keeps the per-sector readback verification simple.

## Root causes (legacy `-bbl1`)

1. **Poll quantum starved the byte state machine.** `bbl_card_poll` stopped after 16 `sd_poll` steps or 8 µs. Each SPI byte needs about 2–3 steps, so a background call moved only about 5–8 bytes. Throughput therefore scaled with main-loop idle cadence, not with the SPI clock.
2. **Three transfers per data sector.** `fat32_log.c` wrote each sector and then read it back twice. The `DO_DATA_WRITE` and `READ_VERIFY_DATA` states each issued a readback. This is about 1,600 SPI bytes of traffic for 512 B of log data.
3. **FAT free-cluster scan restarted at cluster 2 at every cluster boundary.** FSInfo `next_free` is invalidated while a file is open, and no in-RAM hint was kept. The cost is 2 × (used clusters / 128) FAT reads per new cluster. With 20,000 clusters already used, that is about 314 extra reads per 16 KiB cluster, or about 10 extra sector reads per data sector.
4. **Serialized session.** The session encoded one frame per poll and stopped draining the recorder while a sector was in flight. Only the 64-sample recorder FIFO (128 ms at 500 Hz) absorbed card stalls, which are commonly 10–100+ ms.

The same host byte-level card model run against the unchanged legacy code:

| Legacy scenario (500 Hz, 1 kHz loop) | Loss |
|---|---|
| empty card, 12 µs foreground per loop | 0 % |
| populated card (20,000 used clusters), 12 µs foreground | 59.2 % |
| empty card, 60 µs foreground | 56.8 % |
| populated card, 60 µs foreground | **85.7 %** (physical log: 85.2 %) |

## Fix (`-bbl2`)

- **Time-bounded quantum.** `scheduler_bg_budget_us()` returns the time to the next gyro deadline minus a 20 µs guard, capped at 200 µs. The Blackbox background work (up to 4,096 SD steps and 64 session steps) stops at that deadline. The control loop never waits on SD. The capture hook still only pushes into the recorder FIFO.
- **64 KiB encoded-byte ring** in SRAM1 (`.dma`, not DTCM). The session encodes up to 16 frames per poll while at least 256 B of ring space is free, so recorder draining is decoupled from sector writes. At 34.5 KiB/s the ring rides out about 1.8 s of card stall on top of the 128 ms FIFO.
- **One readback per data sector.** The full-sector readback verification is kept.
- **Allocation hint.** The FAT scan resumes from the last allocated cluster + 1 instead of cluster 2.
- **Honest auto-rate.** The rate is evaluated over 1 s windows. If queue-full drops exceed 1 % of that window's capture attempts, the rate halves (500 → 250 → 125, floor 125 Hz). After a halving, one settle window is skipped. The rate is never raised mid-session. Invalid or clock-regressed samples do not count toward the trigger.
- **Effective rate in the log.** The header has a fixed-width 128 B rate block in sector 0: `H I interval`, `H P interval`, `H BobFlight log_rate_hz:<hz> requested_hz:<hz> reason:<reason>`. When the rate was lowered, sector 0 is rewritten in place (with readback) at close to the effective rate. The rewrite happens only if the re-encoded header has the same length and the rest of the header is unchanged. Otherwise the log closes without the patch, and `blackbox status` still reports the effective rate.

## Host model results (`bobflight_blackbox_throughput_test`)

This is a byte-level SPI SD emulator on a virtual clock that drives the real CLI → session → FAT32 → `sd_spi` path. It uses a 1 kHz loop with 60 µs of task cost and a FAT32 volume with 20,000 used clusters.

| Card model | Result |
|---|---|
| realistic: 0.8 ms busy, 0.4 ms read latency, 80 ms stall every 128 writes | 9,845 frames, **0 dropped**, 500/500 Hz, ring peak 3.4 KiB, quantum overrun ≤ 1 µs |
| same, plus 60 µs extra foreground per loop | 9,825 frames, **0 dropped** |
| slow: 15 ms busy per write | lowered once to **250 Hz**, 92 dropped (1.7 %), header patched to `log_rate_hz:250` |
| very slow: 70 ms busy per write | floors at **125 Hz** after 2 lowerings, 28.4 % dropped, reported, not hidden |

The model parameters are assumptions. Only a physical re-log on the Kakute confirms real-card behavior and the actual per-byte CPU cost.
