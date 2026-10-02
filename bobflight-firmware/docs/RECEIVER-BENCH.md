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
  **LQ is 0**, or when **no stats frame has arrived for more than 1 s**
  (`RX_LINK_STATS_STALE_MS` = 1000 ms; exactly 1000 ms is still fresh).
- While the link counts as lost, valid RC frames are **not accepted**: channels,
  the frame counter and the failsafe loss timer are left untouched. This covers a
  receiver that keeps sending frozen or preset channels after its RF link is gone.
  The **existing** failsafe then runs unchanged: after 250 ms without an accepted
  frame it enters HOLD, and with the default action (DROP, zero hold window) it
  disarms and the mixer writes DShot 0. Configured HOLD/LAND actions behave as
  they do for a frame stop.
- Timing: motors are cut **~250 ms after LQ 0 arrives** (host test: 251 ms), and
  **~1.25 s after the last stats frame** when stats go stale (1 s stale threshold
  plus the 250 ms failsafe timeout; host test: 1251 ms).
- The loss surfaces as `failsafe: ACTIVE` in `status` (the Configurator Arm gate
  reads that) and `failsafe: 1` in `receiver`.
- Recovery: a stats frame with LQ > 0 lets the next RC frame through and clears
  failsafe. There is **no automatic re-arm**: arming still needs a new
  inactive-to-active edge of the ARM range at low throttle.

The `receiver` report gains three lines before `receiver_end: 1`:

```
rx_link_stats: present|absent
rx_link_lq: <integer 0..100|unavailable>
rx_loss_reason: none|no-frames|lq-zero|stats-stale
```

- `rx_link_stats: absent` means no valid stats frame since boot / receiver
  re-initialisation (frames-only detection).
- `rx_link_lq` is the latest uplink LQ while stats are present and not stale;
  `unavailable` when absent or stale (an old LQ is never shown as current).
- `rx_loss_reason`: `no-frames` when no valid RC frame (accepted or held back)
  arrived for more than 250 ms, or none ever; otherwise `stats-stale` or
  `lq-zero` while the stats gate is closed; otherwise `none`.

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
re-initialisation). `crsf_parse` checks the stats frame parser (length, type, CRC,
LQ > 100 rejected). `failsafe_integration_link-*` run the real scheduler, CRSF
parser, failsafe, arming and mixer: frozen-but-valid frames + LQ 0 disarm at
251 ms with DShot 0 and failsafe active; stale stats disarm at 1251 ms; absent
stats keep today's frames-only behaviour; recovery does not re-arm. The failsafe
test covers retaining policy on RX reset. `npm --prefix ui run test:receiver` checks the UI parser and
real client allowlist with mock serial; passing a host firmware executable to
`ui/scripts/test-receiver.cjs` additionally verifies actual firmware CLI readback.

Public protocol reference: https://github.com/tbs-fpv/tbs-crsf-spec/blob/main/crsf.md
