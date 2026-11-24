# CRSF receiver bench support

The Receiver page and firmware use the `receiver` command (API 1, complete end
marker required). The snapshot contains UART, input mapping, 16 mapped controls,
link state, RC-frame age/count, CRC errors, stream resets, and arm/bench/failsafe
state. It is separate from sensor `status`, keeping both replies bounded.

Channel values are normalized controls: roll/pitch/yaw and AUX are -1..1;
throttle is 0..1. AUX1 remains channel 5 and is reserved for arming. AETR is the
default input order; TAER is available. AUX channels are not remapped. These are
not measured PWM pulse widths or raw CRSF integers.

## Corrections

- Only complete finite, in-range 16-channel data can refresh RX freshness.
- A CRC failure or a non-RC frame never refreshes the receiver-loss timer.
- Partial input is discarded after 10 ms idle. Following a polling gap over
  10 ms, the pending UART ring is drained with a bounded read budget so old
  buffered controls cannot appear newly received. This is deliberately conservative;
  sustained scheduler stalls can cause loss indications and need diagnosis.
- Channel data is stale after 250 ms; the UI hides stale bars and also hides
  values after 750 ms without a new complete diagnostics reply.
- UART and mapping changes are refused while armed or during motor bench work.
- Reconfiguration invalidates the previous RX link without resetting the selected
  failsafe action/timers. It requires fresh channel input again.
- UART open state is cleared before reconfiguration, including GPIO failure paths.

## CRSF link statistics (LQ) as an RX-loss input

The firmware parses CRSF `LINK_STATISTICS` (frame type `0x14`, 10-byte payload;
uplink link quality is payload byte 2, a percentage). A stats frame is used only
if its sync byte, length (12), type and CRC8 are valid and the uplink LQ is
0..100; anything else is ignored and never refreshes the stats timer. There is
**no new setting**.

Rule (all thresholds are fixed constants):

- **Absent** (no valid stats frame since boot, or since the last `receiver_map` /
  `receiver_uart` re-initialisation, which forgets the old link): loss detection
  is frames-only, exactly as before this change.
- Once stats have been seen, the link counts as lost when the latest uplink
  **LQ is 0**, when **no stats frame has arrived for more than 1 s**
  (`RX_LINK_STATS_STALE_MS` = 1000 ms; exactly 1000 ms is still fresh), or when
  the **RC frames arrive too slowly**: the last 8 valid RC frames
  (`RX_LINK_RATE_FRAMES`) span more than 1000 ms (`RX_LINK_RATE_SPAN_MS`), i.e.
  under ~8 frames per second (`link-rate-low`).
- **A ~4 Hz link is treated as link loss** (decision of Oct 2, unchanged). A link
  that drops to ~4 Hz mid-flight goes into failsafe instead of flying on: the
  controls are far too slow to fly on, so it is handled exactly like LQ 0 (same
  gate, same 250 ms failsafe, same `failsafe: ACTIVE`). 25 Hz takes 280 ms for 8
  frames (560 ms with every other packet lost); 4 Hz takes 1750 ms.
- **N2: the CRSF rf_mode byte (payload byte 5) is never a loss reason.** It is a
  vendor index, not a rate: TBS Crossfire reports 0 for its 4 fps mode, while
  ExpressLRS 4.x reports 0 for its valid 900 MHz 25 Hz rate
  (`RATE_LORA_900_25HZ = 0`; ExpressLRS 3.x reports 25 Hz as 1 and 0 is its
  unused 4 Hz enum slot). Before N2 rf_mode 0 closed the gate, which put a
  healthy 25 Hz ExpressLRS 4.x link into failsafe. The ~4 Hz policy is now
  measured from the RC frames themselves, for every protocol. rf_mode is still
  parsed and reported (blackbox `link_rf_mode`).
- Until 8 valid RC frames have arrived since boot or receiver re-initialisation
  the frame rate is unknown, and with stats present unknown counts as slow (fail
  closed): the first 7 frames after a re-initialisation are held back.
- While the link counts as lost, valid RC frames are **not accepted**: channels,
  the frame counter and the failsafe loss timer are left untouched. This covers a
  receiver that keeps sending frozen or preset channels after its RF link is gone.
  The **existing** failsafe then runs unchanged: after 250 ms without an accepted
  frame it enters HOLD, and with the default action (DROP, zero hold window) it
  disarms and the mixer writes DShot 0. Configured HOLD/LAND actions behave as
  they do for a frame stop.
- Timing: motors are cut **~250 ms after LQ 0 arrives** (host tests: 251 ms),
  **~250 ms after the last accepted frame of a ~4 Hz link** (host test with a
  frame every 200 ms: 1052 ms after the rate dropped), and
  **~1.25 s after the last stats frame** when stats go stale (1 s stale threshold
  plus the 250 ms failsafe timeout; host test: 1251 ms).
- The loss surfaces as `failsafe: ACTIVE` in `status` (the Configurator Arm gate
  reads that) and `failsafe: 1` in `receiver`.
- Recovery: a fresh stats frame with LQ > 0 **and** a normal RC frame rate
  reopen the gate; the next accepted RC frame then clears failsafe under the
  existing rule (the failsafe clears on an accepted frame). There is no shortcut:
  valid frames at ~4 Hz, a stats frame with LQ 0, or stats alone without an RC
  frame leave failsafe ACTIVE. There is **no automatic re-arm**: arming still needs a new
  inactive-to-active edge of the ARM range at low throttle.

The `receiver` report gains three lines before `receiver_end: 1`:

```
rx_link_stats: present|absent
rx_link_lq: <integer 0..100|unavailable>
rx_loss_reason: none|no-frames|lq-zero|link-rate-low|stats-stale
```

- `rx_link_stats: absent` means no valid stats frame since boot / receiver
  re-initialisation (frames-only detection).
- `rx_link_lq` is the latest uplink LQ while stats are present and not stale;
  `unavailable` when absent or stale (an old LQ is never shown as current).
- `rx_loss_reason`: `no-frames` when no valid RC frame (accepted or held back)
  arrived for more than 250 ms, or none ever; otherwise `stats-stale`,
  `lq-zero` or `link-rate-low` while the stats gate is closed; otherwise
  `none`. Priority: no-frames > stats-stale > lq-zero > link-rate-low. Stale
  stats have no current LQ, so a stale link reports `stats-stale` even if its
  last frame said LQ 0 (fail-safe either way: the gate is closed).
  `link-rate-low` is reported only with stats present and fresh; with stats
  absent it never appears (no frames -> `no-frames`, frames -> `none`,
  frames-only as before). `rx_link_lq` still shows the latest LQ during
  `link-rate-low`. Firmware before N2 sent `rf-mode-low` (rf_mode 0) instead.

## Bench check after merging and rebuilding both components

1. Remove props. Power the receiver and turn on the transmitter.
2. Open Receiver. Select the board RX pad connected to the receiver TX wire.
   Defaults remain UART6, CRSF 420000 baud. The applied UART is read back.
3. Choose AETR or TAER to match the transmitter. Move each stick individually:
   roll/pitch/yaw center around 0%, throttle spans 0..100%, AUX switches follow.
4. Turn the transmitter off while props remain removed. Verify the frame counter
   stops, link becomes lost, bars disappear, and failsafe becomes active. A
   receiver that keeps sending valid held channels defeats frame-timeout detection
   unless it also sends CRSF link statistics: with stats present, LQ 0 or stats
   missing for more than 1 s is treated as loss (see above). Check that
   `rx_link_stats` reads `present` for your receiver; if it reads `absent`, verify
   the receiver actually stops RC frames when its RF link is lost.
5. Restore the transmitter and verify live controls return. Reboot to verify
   the documented UART6/AETR defaults and repeat with any runtime settings applied.

Settings are until-reboot only; flash persistence is not implemented. This page
does not arm motors. RF binding, RSSI telemetry, arbitrary channel remapping,
serial baud negotiation and CRSF subset-channel frames are not implemented.
This change does not certify flight readiness or fix the separate LAND mixer issue.

## Tests

`ctest` includes real rx.c + crsf.c driven by a fake UART/time source: fragmented
input, corrupt CRC, partial-frame timeout, non-RC traffic, stale buffered data,
mapping, invalid controls and uint32 clock wrap, plus the LINK_STATISTICS gate
(absent, LQ 0, the 1000/1001 ms stale boundary, recovery, no-frames precedence,
re-initialisation) and the N2 rate rule: rf_mode 0, 1, 2 and 7 with good LQ are
not a loss; ExpressLRS 25 Hz (rf_mode 0, a frame every 40 ms, and every 80 ms at
LQ 50) is never a loss over 5 s; LQ 0 and stale stats are a loss whatever the
rf_mode; a frame every 200 ms is `link-rate-low` with rf_mode 0, 1 or 2 and
refreshes nothing; recovery at 25 Hz; the first 7 frames after
re-initialisation are held back; lq-zero beats link-rate-low; stats absent keep
4 Hz frames frames-only. `crsf_parse` checks rf_profile is read from payload byte 5. `crsf_parse` checks the stats frame parser (length, type, CRC,
LQ > 100 rejected). `failsafe_integration_link-*` run the real scheduler, CRSF
parser, failsafe, arming and mixer: frozen-but-valid frames + LQ 0 disarm at
251 ms with DShot 0 and failsafe active; stale stats disarm at 1251 ms;
`link-rf0-25hz`: rf_mode 0 with LQ 90 and a frame every 40 ms stays armed for
5 s, then LQ 0 still disarms within 252 ms; `link-rate-low`: LQ 90, rf_mode 2,
a frame every 200 ms disarms 1052 ms after the rate dropped, failsafe ACTIVE, an
arm edge is refused, failsafe is not cleared by ~4 Hz frames (rf_mode 2 or 0),
only by a normal rate and an accepted frame, and re-arming needs a new edge; absent
stats keep today's frames-only behaviour; recovery does not re-arm. The failsafe
test covers retaining policy on RX reset. `npm --prefix ui run test:receiver` checks the UI parser and
real client allowlist with mock serial; passing a host firmware executable to
`ui/scripts/test-receiver.cjs` additionally verifies actual firmware CLI readback.

Public protocol reference: https://github.com/tbs-fpv/tbs-crsf-spec/blob/main/crsf.md

## Report keys contract on main (after S1)

S1 added `report_keys_contract`, which pins the `receiver` keys and order to the
b77b845 capture. That golden is kept as the reference and is not re-captured: the
contract now expects exactly `rx_link_stats`, `rx_link_lq`, `rx_loss_reason`, in
that order, immediately before `receiver_end`, and nothing else new. Any other
receiver key or order change still fails. (`receiver` is not part of
`report_bytes_contract`; the values are locked by `test-receiver.cjs` against the
real host build.)
