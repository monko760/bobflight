# Configured ARM switch integration

The configured ARM range now drives the existing guarded receiver arm/disarm path instead of hardcoded AUX1 thresholds. **The bench lockout remains enabled, flight enable remains OFF, and this is not flight qualification.** Direct CLI `disarm` behavior is unchanged; CLI `arm` changed in N2 (below). Control-mode routing is still separately restricted; this does not enable Acro/Horizon flight.

## Behavior

- ARM uses its existing persisted enabled flag, AUX1–12 assignment and inclusive minimum/maximum equivalent-microsecond bounds. Defaults remain AUX1, 1751–2100. It is independent of manual/AUX control-mode selection.
- A fresh, finite, valid receiver value **outside** the enabled ARM range disarms and establishes an inactive-switch witness. A later **inside** value attempts arming once. Every attempt consumes the witness, including refusal for throttle, tilt or calibration. Fixing the refusal while leaving the switch active never retries automatically.
- Booting with the switch active, stale/invalid input, disabled ARM, active bench operation while disarmed, manual calibration or health faults cannot manufacture an inactive witness. Every accepted ARM Apply, including reapplying identical values, and every mode reset invalidates the old witness. A→B→A configuration changes cannot reuse an old edge.
- Existing arming checks remain: low throttle, healthy/fresh sensors and receiver, gyro/attitude qualification, tilt, failsafe and MCU compile-time bench lockout. Configuration does not grant permission to arm. A range covering every possible switch position cannot arm because no valid inactive state can be observed.
- Existing HOLD/LAND processing takes precedence over stale ARM input. Fresh receiver recovery outside the configured range disarms. DROP and LAND expiry still stop through the existing path; recovery while active cannot automatically re-arm after disarm.
- Runtime ARM input does not use the bench-output preview mask: that output-pending flag is also true during normal armed output. The controller therefore does not disarm itself merely for producing a motor command.

Outside-range means any valid position outside the interval, not necessarily the lowest physical switch position. For a middle-position ARM range, both outer positions are inactive. This is an intentional change from the old fixed AUX1 low/high thresholds.

## N2: CLI `arm` uses the same gate and never arms

Before N2 the CLI `arm` command called `arming_try_arm()` directly. That skipped the fresh-switch-edge, calibration and tilt checks of the switch path, and because the PID loop keeps an arm only while the ARM switch is active, the only time a USB arm stuck was with the ARM switch **already on**: a USB arm with no switch flip.

Now both paths read one gate. `arming_block_reason()` (arming.c) holds every check `arming_try_arm()` applies; `arm_gate_block()` (tasks.c) adds calibration, attitude-ready and tilt (leveled modes only) and is what the switch edge in `loop_pid` evaluates before `arming_try_arm()`. Switch arming behavior is unchanged.

The CLI `arm` command cannot be a fresh switch edge, so it never arms. It replies `arm refused: <token>` with the first blocking check, in this order:

| Token | Meaning |
|---|---|
| `already-armed` | already armed (by the switch); nothing changed |
| `motors-active` | a bench motor test/session is running |
| `calibration-running` | manual sensor calibration is running |
| `bench-build`, `no-motor-output`, `receiver-stale`, `gravity-not-ready`, `gyro-not-ready`, `gyro-unhealthy`, `failsafe`, `throttle-not-low` | the `arming_try_arm()` checks (the first three and the readiness pair only on MCU builds) |
| `dshot-unhealthy` | motor output unhealthy (the PID loop would disarm) |
| `arm-switch-unavailable` | ARM range disabled/invalid or no fresh receiver value |
| `arm-switch-on` | the ARM switch is already on: switch it off, then on |
| `gyro-not-calibrated`, `attitude-not-ready`, `tilted` | the switch-edge checks |
| `arm-switch-required` | every check passes; arm with the radio ARM switch (off, then on) |

So `arm` is now a pre-arm check. The Configurator Status page shows the reply verbatim with an explanation.

Capability signal: N2+ firmware prints `arm_cli: check` in `status`, right after the `arm:` line. Firmware before N2 really arms on `arm`, so the Configurator sends `arm` (Status page "Arm check…" → "Confirm arm check" → "Run arm check", the CLI tab, and the protocol client's `arm()`) only after a fresh `status` that contains exactly one `arm_cli: check` line. When the key is absent, Arm check stays disabled and shows: "Older firmware: the CLI arm command can arm this board. Update firmware to use Arm check." A designed props-off USB arm path, if wanted, is a separate change.

## Configuration and compatibility

No persistence layout, version, field or flash backend changed. Existing saved ARM assignments become authoritative for this receiver path. Existing Betaflight-style `diff all` and explicit `save` remain the way to review and retain configuration; do not silently overwrite saved settings with defaults.

Firmware reports `arm_semantics: configured` in the existing four-row Modes API 2 snapshot. The matching UI displays **ARM — configured switch** and explains the remaining interlocks. New UI still displays legacy `preview` semantics honestly for older firmware. Old strict configurators may reject the new semantic value; update both components together.

The range-active indicator remains a match snapshot, not proof of armed state or physical motor activity. The old fixed-8% AUX1 bench session is a separate test mode and is not reassigned by this ARM setting.

## Software validation

Native regression includes actual scheduler, RX, arming, failsafe, PID, mixer and DShot encoding with mocked hardware. Added cases cover custom AUX12, active-at-boot, edits and A→B→A, disabled/stale input, high-throttle/health/calibration/tilt refusal, bench cancellation, middle-position ranges, inclusive boundaries, unarmable full-span ranges, custom-switch HOLD/LAND and control-source independence. Unit tests cover all 12 AUX-to-array mappings, invalid data and preview/runtime separation. Persistence simulation restores AUX11 and verifies it feeds the same runtime input helper; no fresh switch is fabricated by restore.

Existing timing tests retain their assertions; fixtures now initialize the real ARM configuration and supply an active switch when deliberately mocking armed state. Real firmware snapshots pass through the configurator parser, with legacy compatibility and no command on UI rendering verified.

Native tests do not establish physical switch behavior, motor correction signs, ESC stopping, calibration quality or flight readiness. No MCU binary or hardware operation is required for reviewing this source change.

## Later installation and acceptance — not requested now

Hardware testing is currently parked. Review/merge is not a request to rebuild or flash. When intentionally updating later, follow `BOOTLOADER.md` and the board-specific bench build with flight enable OFF; use matching firmware/configurator, preserve `diff all`, and review any dirty configuration before explicit `save`. Do not mass-erase controller configuration. Keep the established guarded `bl` / `bl discard` and independent recovery route available; software bootloader access is not recovery from broken USB/startup.

With props removed and motor power disconnected, first verify board identity, disarmed state, the retained ARM AUX/range and `arm_semantics: configured`. Confirm the UI's displayed range match follows the selected channel, not necessarily AUX1. A bench image must remain unable to flight-arm. Do not use an arming or motor-start attempt as proof that this integration is ready for flight.

Stop on unexpected output, armed state, wrong target, lost configuration, mismatched semantics, or unreliable USB. Disconnect motor power and use the documented recovery procedure; do not defeat any interlock to complete a check. These later checks remain separate from eventual props-off control-chain and flight qualification.
