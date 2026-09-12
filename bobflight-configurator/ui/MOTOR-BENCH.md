# Props-off motor workbench

Original BobFlight implementation, Apache-2.0. This configurator change requires
no new HEX when using the bench firmware from main `ee46b2b` or compatible later
firmware. It is not a flight-qualification or hardware-validation result.

## Controls

- Top view, front at the top: M4 front-left, M2 front-right, M3 rear-left,
  M1 rear-right. Each individual request is a one-second, 8% command pulse.
  This is a command value, **not measured RPM**.
- Sequence explicitly requests M1 → M2 → M3 → M4. Firmware inserts 0.7-second
  gaps. The UI uses a conservative seven-second estimated window, including
  the final gap; it is not live motor progress telemetry.
- DShot300/600 selector queries `dshot` and confirms readback after changes.
  Selection lasts until reboot. Choose only a rate supported by the ESC.
  The old firmware's `motor_output: DShot300 ready` string is health evidence
  only: it is hardcoded even when 600 is selected.
- Stop sends `motor_test 0`. It remains enabled while connected regardless of
  props acknowledgment, readiness, pending operation, or test-window lock.
  Firmware uses the same generic acknowledgment for Stop and individual tests;
  the UI explains it as a Stop acknowledgment, **not proof of physical stopping**.

## Gates and limitations

Remove ALL props, secure the frame, keep hands clear, and retain easy access to
battery power. Flight arming being disabled does not disable bench motor output.
USB alone does not supply motor power.

An explicit props-off acknowledgment and a visual stationary confirmation are
required. Stationary confirmation clears after each test. Both clear after
reconnect, leaving the page, or hiding it. Starts and rate changes require a
fresh (≤1.5s) status, disarmed, four bound outputs, permitted MMIO and a recognized
healthy motor-output string. A fresh status is requested again just before the
command. Bench-only flight/RX fail-closed flags are not incorrectly treated as
motor-output faults. `help` is checked for supported commands; unavailable
features are disabled rather than guessed.

Controller transactions are serialized. Starts are never queued or retried.
Stop invalidates unsent requests and waits behind any already-sent transaction;
the shared host command gate also prevents another tab's polling from overtaking
Stop. Session generations cancel outstanding requests across reconnects. Leaving
or hiding the page attempts a best-effort stop, with no guarantee on browser
termination or lost USB. A stuck USB command can delay Stop until timeout.
**If motors keep spinning, disconnect battery power.**

There is no measured RPM, motor direction, active-sequence telemetry or physical
stop sensor. No automatic direction reversal, flight arming, variable-throttle
slider, or persistent speed setting is introduced.

## Offline simulation and tests

In Connect, choose mock mode and select **Motor bench demo — SIMULATED**
(`mock://bobflight-bench`). The Motors page explicitly labels the simulation.
The ordinary mock remains output-unavailable. Neither mock drives hardware;
passing simulation tests does not prove hardware behavior.

From `bobflight-configurator/`:

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm --prefix protocol run test:motors
npm --prefix ui run test:motors
npm --prefix ui run smoke
npm run build
```

The 17 controller/gate regression tests use deterministic clocks and deferred
promises to cover stale/unknown status, arm/output/confirmation gates, pulse and
sequence windows, Stop during preflight or an in-flight pulse, reconnect,
unmount/hide, malformed/refused acknowledgments, older firmware, mock behavior,
and cross-page Stop priority. Protocol tests cover exact allowlisted commands,
injection/invalid argument rejection, transport responses and mock time windows.
Both new suites run in CI in addition to existing firmware/configurator checks.
