# Props-off motor workbench

Original BobFlight implementation, Apache-2.0. Adjustable pulse sliders require
**updated firmware exposing `motor_pulse`** in addition to this configurator.
The older `ee46b2b` bench HEX can still perform fixed 8% tests but cannot use
adjustable pulses. This is not a flight-qualification or hardware-validation
result. Do not flash a development artifact as flight firmware.

## Controls

- Top view, front at the top: M4 front-left, M2 front-right, M3 rear-left,
  M1 rear-right. Each slider prepares an integer **0–35% command** (initially
  zero). Moving a slider does NOT send a USB command or start a motor. Press
  the explicit Test button for a one-second pulse at that selected value.
  It is a normalized command, **not measured power or RPM**. The initial bench
  cap is not a guarantee of harmless output; props MUST be removed.
- `motor_pulse <1..4> <0..35>` enforces motor, percent and one-second duration
  in firmware, not just in HTML. Zero stops ALL bench tests. Any nonzero pulse
  cancels an existing sequence and requests only the selected motor. Bad,
  non-integer, negative, extra or overflow input is refused, not clamped.
  Existing `motor_test <0..4>` fixed 8% behavior is unchanged for old clients.
- Sliders and starts cannot modify a pending/active test. A fresh stationary
  acknowledgment is required before another pulse. Stop, reconnect, hiding,
  leaving, revoked props confirmation or an operation error clears setpoints.
  Read-only polling does not prevent preparing a local setpoint.
- Sequence uses **fixed 8%**, independent of slider values, and explicitly
  requests M1 → M2 → M3 → M4. Firmware inserts 0.7-second
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

## Motor pole preference

The editable **Motor pole count** field defaults to **14 magnetic poles / 7 pole
pairs**, a common 2306 FPV starting value requested by the owner. Motor size does
not guarantee pole count: verify the motor's specifications. Save accepts even
integers 2–60. It persists only in this browser's local storage, applies to all
four motors and is shared across connected aircraft; it is **not a firmware
setting** and does not affect motor output yet. If storage is blocked, the UI
reports that the value is page-session-only. Invalid stored data falls back to
14. This prepares configuration for future RPM support, not fabricated telemetry.

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
stop sensor. RPM reads `— / No telemetry`, never a fake zero or a throttle-based
estimate, including in the mock. Bidirectional DShot is not implemented or
silently enabled; see the [RPM implementation roadmap](RPM-ROADMAP.md). No automatic direction reversal, flight arming, continuous
slider drive, master/all-motor slider, or persistent speed setting is introduced.

On old firmware without `motor_pulse`, adjustable sliders stay disabled with
an explicit firmware-update message; the individually labeled fixed 8% buttons
remain available. There is no silent fallback from a requested percent to 8%.

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

The 28 controller/gate/preference regression tests use deterministic clocks and deferred
promises to cover stale/unknown status, arm/output/confirmation gates, pulse and
sequence windows, Stop during preflight or an in-flight pulse, reconnect,
unmount/hide, malformed/refused acknowledgments, older firmware, mock behavior,
cross-page Stop priority, per-motor setpoints, no I/O during slider movement,
zero-as-stop, invalid values, reset conditions and old-firmware fallback.
Protocol tests cover exact allowlisted commands,
injection/invalid argument rejection, transport responses and mock time windows.
Both new suites run in CI in addition to existing firmware/configurator checks.

Firmware regression coverage includes all 144 motor/percent combinations
(motors 1–4, integer percent 0–35), 999/1000 ms cutoff, uint32 clock wrap,
USB/health/arm gates, zero stop, sequence cancellation and legacy 8% restoration.
A real host-CLI stdin test also covers help discovery, unavailable outputs,
overflow/embedded-NUL line discard and clean recovery. Native timer/DMA and
physical spin still require props-off hardware validation.
