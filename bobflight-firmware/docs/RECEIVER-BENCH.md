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

## Bench check after merging and rebuilding both components

1. Remove props. Power the receiver and turn on the transmitter.
2. Open Receiver. Select the board RX pad connected to the receiver TX wire.
   Defaults remain UART6, CRSF 420000 baud. The applied UART is read back.
3. Choose AETR or TAER to match the transmitter. Move each stick individually:
   roll/pitch/yaw center around 0%, throttle spans 0..100%, AUX switches follow.
4. Turn the transmitter off while props remain removed. Verify the frame counter
   stops, link becomes lost, bars disappear, and failsafe becomes active. A
   receiver that keeps sending valid held channels can defeat timeout detection;
   verify your receiver actually stops RC frames when its RF link is lost.
5. Restore the transmitter and verify live controls return. Reboot to verify
   the documented UART6/AETR defaults and repeat with any runtime settings applied.

Settings are until-reboot only; flash persistence is not implemented. This page
does not arm motors. RF binding, RSSI/LQ telemetry, arbitrary channel remapping,
serial baud negotiation and CRSF subset-channel frames are not implemented.
This change does not certify flight readiness or fix the separate LAND mixer issue.

## Tests

`ctest` includes real rx.c + crsf.c driven by a fake UART/time source: fragmented
input, corrupt CRC, partial-frame timeout, non-RC traffic, stale buffered data,
mapping, invalid controls and uint32 clock wrap. The failsafe test covers retaining
policy on RX reset. `npm --prefix ui run test:receiver` checks the UI parser and
real client allowlist with mock serial; passing a host firmware executable to
`ui/scripts/test-receiver.cjs` additionally verifies actual firmware CLI readback.

Public protocol reference: https://github.com/tbs-fpv/tbs-crsf-spec/blob/main/crsf.md
