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

## Host model results (`bobflight_blackbox_throughput_test`, bbl2, schema 2)

_Historical (schema 2 frames, 60 µs cascade). The current matrix is in **Schema 3 drop matrix (BB1)** below._

This is a byte-level SPI SD emulator on a virtual clock that drives the real CLI → session → FAT32 → `sd_spi` path. It uses a 1 kHz loop with 60 µs of task cost and a FAT32 volume with 20,000 used clusters.

| Card model | Result |
|---|---|
| realistic: 0.8 ms busy, 0.4 ms read latency, 80 ms stall every 128 writes | 9,845 frames, **0 dropped**, 500/500 Hz, ring peak 3.4 KiB, quantum overrun ≤ 1 µs |
| same, plus 60 µs extra foreground per loop | 9,825 frames, **0 dropped** |
| slow: 15 ms busy per write | lowered once to **250 Hz**, 92 dropped (1.7 %), header patched to `log_rate_hz:250` |
| very slow: 70 ms busy per write | floors at **125 Hz** after 2 lowerings, 28.4 % dropped, reported, not hidden |

The model parameters are assumptions. Only a physical re-log on the Kakute confirms real-card behavior and the actual per-byte CPU cost.

## Schema 3 drop matrix (BB1)

Log schema 3 (`docs/BLACKBOX-FIELDS.md`) grows the typical frame from about 70.7 B to **about 81 B**: four eRPM fields, five state fields, and `bobflightIteration` removed. The session's encode buffer is now the proven 271 B worst case instead of a fixed 256 B. `host_blackbox_throughput.c` is now table-driven over three loop configurations, with separate gyro-only and PID slot costs (structural estimates from `LOOP-RATE.md`, not measurements). Capture goes through the production schema 3 path (`bb_capture_observe_ex`, decimate first). The test is built twice:

- `blackbox_sd_throughput_model`: default 500 Hz (`BLACKBOX_RATE_DEFAULT_HZ 500u`)
- `blackbox_sd_throughput_model_1k`: the same source with `-DBLACKBOX_RATE_DEFAULT_HZ=1000u`

| Loop config | gyro-only slot | PID slot | fg per bg call |
|---|---|---|---|
| 1000/1 | – | 80 µs | 12 µs |
| 8000/2 (4 kHz PID) | 30 µs | 80 µs | 8 µs |
| 8000/1 (8 kHz PID) | – | 80 µs | 8 µs |

For each loop configuration, the realistic card (0.8 ms busy, 0.4 ms read, 80 ms stall every 128 writes, 20 s, 20,000 clusters already used) must give: effective rate = requested, reason `default`, `dropped == 0`, `drop_pct` exactly `0.0`, `missed == 0`, measured frames/s within 0.5 % of the requested rate, frames == recorder accepted, ring peak ≤ 32 KiB and gyro slot lateness ≤ 25 µs. The one exception is described below.

Results (virtual clock, deterministic):

| Requested | Loop | Frames | Dropped | Missed | Measured rate | Rate | B/frame | Ring peak | Gyro late max |
|---|---|---|---|---|---|---|---|---|---|
| 500 Hz | 1000/1 | 9,842 | **0** (0.0 %) | 0 | 500.1 Hz | 500/500 default | 81.0 | 3.8 KiB | 24 µs |
| 500 Hz | 8000/2 | 9,697 | **0** (0.0 %) | 0 | 500.0 Hz | 500/500 default | 81.7 | 4.4 KiB | 14 µs |
| 500 Hz | 8000/1 | 9,331 | **0** (0.0 %) | 0 | 500.1 Hz | 500/500 default | 80.9 | 5.6 KiB | 14 µs |
| 1000 Hz | 1000/1 | 19,683 | **0** (0.0 %) | 0 | 1000.1 Hz | 1000/1000 default | 81.0 | 7.7 KiB | 24 µs |
| 1000 Hz | 8000/2 | 19,393 | **0** (0.0 %) | 0 | 1000.0 Hz | 1000/1000 default | 81.7 | 8.9 KiB | 14 µs |
| 1000 Hz | 8000/1 | 10,519 | **312 (2.9 %)** | 0 | 563.7 Hz (mixed) | **500**/1000 auto-lowered-card-slow | 81.5 | 64 KiB (ring full) | 13 µs |

"Measured rate" is frames ÷ recording time (first capture to `blackbox stop`) in the model; the firmware does not report it.

**8 kHz PID with 1000 Hz logging cannot reach zero drops on the realistic card in this model.** Each 125 µs slot leaves only about 25 µs of background budget after the 80 µs PID slot and the 20 µs guard. That is not enough to carry about 80 KiB/s through 80 ms card stalls. The test asserts the honest behaviour instead: exactly one halving to 500 Hz, the drops reported in `blackbox status`, and the header patched to `log_rate_hz:500 requested_hz:1000 reason:auto-lowered-card-slow`. The firmware default stays 500 Hz.

**Jitter-missed slots at 1000/1 with 1000 Hz logging (fixed, BB1 QA F2).** The recorder anchors its logging grid at the first sample (`next_due`) and used to accept a loop only at or after the deadline. The scheduler is phase-preserving, but each PID loop starts 0–25 µs late (background quantum), so loop times jitter around the grid. When the log period equals the PID period, a loop a few µs *before* `next_due` was decimated, and the next loop, about one period later, either counted the slot as `missed` or filled it ~1 ms late, so the grid kept sitting on the jitter boundary. The model logged 15,983 frames in 20 s (~799 Hz) with 3,700 missed (QA measured 15,980 / 3,703 at a85f492) while status read 1000/1000, `drop_pct 0.0`. At 8000/2 and below the next loop is only a fraction of a log period later, so jitter cost lateness, not slots.

Fix (`flight_recorder.c`, `due()`): a loop is also due when it is early by **less than half of its own loop interval**, i.e. it is the loop nearest the deadline. An exact tie waits for the on-time loop. The tolerance is always below half the log period, so one slot never takes two loops. Accepted samples keep their true timestamps (nothing is re-timed or fabricated), and an early sample fills `next_due` itself, so it counts no miss. Late samples are counted exactly as before. `recorder_skip_if_not_due()` uses the same predicate, so decimate-first counters still match `recorder_capture()`.

After the fix, `blackbox_missed` counts only logging slots that had no PID loop at all, which is a real scheduler stall. Test (f) runs each loop on a fast card with a 10.5 ms foreground stall about once a second. 1000/1 @ 1000 Hz: 9 stalls → `blackbox_missed` 81 (9 per stall, 0.83 % of slots), measured 991.8 Hz, dropped 0. 8000/2 @ 1000 Hz: 85 missed. At 500 Hz: 36 / 38 / 35 missed for 1000/1, 8000/2 and 8000/1. Without stalls every loop configuration shows missed 0 and a measured rate within 0.5 % of the requested rate. `blackbox_drop_pct` is unchanged: it is still `dropped / (frames + dropped)` (frozen api 2 value, pinned by the Configurator's `formatDropPct`). Missed slots are reported only in `blackbox_missed`, and the auto-rate policy ignores them because a CPU stall is not a slow card.

Threshold cards: per loop configuration, a card that is just too slow for the requested rate must halve **exactly once**, report its drops, and get the header patched in place (12 s runs):

| Requested | Loop | Card busy | Result |
|---|---|---|---|
| 500 Hz | 1000/1 | 15 ms | 250 Hz, 1 lowering, 103 dropped (2.3 %) |
| 500 Hz | 8000/2 | 12 ms | 250 Hz, 1 lowering, 81 dropped (1.8 %) |
| 500 Hz | 8000/1 | 8 ms | 250 Hz, 1 lowering, 17 dropped (0.4 %) |
| 1000 Hz | 1000/1 | 6 ms | 500 Hz, 1 lowering, 119 dropped (1.5 %) |
| 1000 Hz | 8000/2 | 5 ms | 500 Hz, 1 lowering, 96 dropped (1.3 %) |
| 1000 Hz | 8000/1 | 2 ms | 500 Hz, 1 lowering, 415 dropped (6.1 %) |

Card-busy sweeps (12 s) give the largest per-block busy time that still records with zero drops:

| Requested | 1000/1 | 8000/2 | 8000/1 |
|---|---|---|---|
| 500 Hz | 10 ms | 8 ms | 5 ms |
| 1000 Hz | 4 ms | 2 ms | none (the realistic card already halves) |

These results are also asserted:

- 1000/1 with 60 µs of foreground work per background call: 0 drops at the requested rate. Gyro lateness is not asserted in this case; the model shows up to 120 µs, which is 2 × the injected foreground.
- A 70 ms card floors at 125 Hz (2 lowerings at 500 Hz requested, 3 at 1000 Hz).
- The four `blackbox status` replies from the 500 Hz build that the Configurator contract reads: idle, realistic 1000/1, 15 ms threshold, 70 ms floor.

**Model gyro lateness:** the background slice adds its foreground cost twice (CLI slice and main-loop poll) without re-checking the gyro deadline. Lateness is therefore bounded by about 2 × that cost (24 µs at 12 µs). It is not a scheduler measurement.

**Auto-rate change in this commit:** the 1 % trigger now counts against due logging slots (`total_attempted − total_skipped`), not every PID loop. Before, at 8 kHz PID / 500 Hz logging, the trigger was effectively about 16 % of frames.

All of this is a host model. Physical-card throughput, real per-byte CPU cost and real cascade cost at 4/8 kHz are still unmeasured.
