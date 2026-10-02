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
  **LQ is 0**, when the latest **fresh** stats frame reports **rf_profile 0**
  (CRSF 4 fps mode; payload byte 5, enum 4fps=0, 50fps=1, 150fps=2), or when
  **no stats frame has arrived for more than 1 s** (`RX_LINK_STATS_STALE_MS` =
  1000 ms; exactly 1000 ms is still fresh).
- **4 fps is treated as link loss.** A link that drops to 4 fps mid-flight goes
  into failsafe instead of flying on: at 4 fps the controls are far too slow to
  fly on, so it is handled exactly like LQ 0 (same gate, same 250 ms failsafe,
  same `failsafe: ACTIVE`). rf_profile 1 (50 fps) and 2 (150 fps), and any other
  value, are not a loss.
- While the link counts as lost, valid RC frames are **not accepted**: channels,
  the frame counter and the failsafe loss timer are left untouched. This covers a
  receiver that keeps sending frozen or preset channels after its RF link is gone.
  The **existing** failsafe then runs unchanged: after 250 ms without an accepted
  frame it enters HOLD, and with the default action (DROP, zero hold window) it
  disarms and the mixer writes DShot 0. Configured HOLD/LAND actions behave as
  they do for a frame stop.
- Timing: motors are cut **~250 ms after LQ 0 or rf_profile 0 arrives** (host
  tests: 251 ms), and
  **~1.25 s after the last stats frame** when stats go stale (1 s stale threshold
  plus the 250 ms failsafe timeout; host test: 1251 ms).
- The loss surfaces as `failsafe: ACTIVE` in `status` (the Configurator Arm gate
  reads that) and `failsafe: 1` in `receiver`.
- Recovery: a fresh stats frame with LQ > 0 **and** rf_profile != 0 reopens the
  gate; the next accepted RC frame then clears failsafe under the existing rule
  (the failsafe clears on an accepted frame). There is no shortcut: valid frames
  at 4 fps, a stats frame with rf_profile != 0 but LQ 0, or stats alone without
  an RC frame leave failsafe ACTIVE. There is **no automatic re-arm**: arming still needs a new
  inactive-to-active edge of the ARM range at low throttle.

The `receiver` report gains three lines before `receiver_end: 1`:

```
rx_link_stats: present|absent
rx_link_lq: <integer 0..100|unavailable>
rx_loss_reason: none|no-frames|lq-zero|rf-mode-low|stats-stale
```

- `rx_link_stats: absent` means no valid stats frame since boot / receiver
  re-initialisation (frames-only detection).
- `rx_link_lq` is the latest uplink LQ while stats are present and not stale;
  `unavailable` when absent or stale (an old LQ is never shown as current).
- `rx_loss_reason`: `no-frames` when no valid RC frame (accepted or held back)
  arrived for more than 250 ms, or none ever; otherwise `lq-zero`,
  `rf-mode-low` or `stats-stale` while the stats gate is closed; otherwise
  `none`. Priority: no-frames > lq-zero > rf-mode-low > stats-stale. Stale
  stats have no current LQ or rf_profile, so a stale link reports `stats-stale`
  even if its last frame said LQ 0 or rf_profile 0 (fail-safe either way: the
  gate is closed). `rf-mode-low` is reported only with stats present, fresh
  (within 1000 ms) and the latest rf_profile 0; with stats absent it never
  appears (no frames -> `no-frames`, frames -> `none`, frames-only as before).
  `rx_link_lq` still shows the latest LQ during `rf-mode-low`.

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
re-initialisation) and rf_profile: 0 closes the gate (`rf-mode-low`), 1, 2 and 7
do not; LQ 0 + rf 0 is `lq-zero`; rf 0 going stale is `stats-stale` at 1001 ms;
no-frames wins; recovery needs LQ > 0 and rf != 0; stats absent never give
`rf-mode-low`. `crsf_parse` checks rf_profile is read from payload byte 5. `crsf_parse` checks the stats frame parser (length, type, CRC,
LQ > 100 rejected). `failsafe_integration_link-*` run the real scheduler, CRSF
parser, failsafe, arming and mixer: frozen-but-valid frames + LQ 0 disarm at
251 ms with DShot 0 and failsafe active; stale stats disarm at 1251 ms;
`link-rf-mode-low`: rf_profile 0 with LQ 90 and valid frames disarms at 251 ms,
failsafe ACTIVE, an arm edge is refused, failsafe is not cleared by 4 fps frames,
by rf != 0 with LQ 0 or by stats alone, only by rf != 0 + LQ > 0 stats and then
an accepted frame, and re-arming needs a new edge; absent
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
