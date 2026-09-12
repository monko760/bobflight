# Protocol transport deliverable

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Proposed API surface summary

Package entry (src/index.ts) exports:

- BobFlightCliClient
  - enumeratePorts(): Promise<PortInfo[]>
  - connect({ path, baudRate?, transport? }): Promise<void> — never auto-arms
  - disconnect(): Promise<void>
  - sendCommand(cmd, opts?): Promise<string> — help|version|status|arm|disarm|reboot
  - onLine(cb): () => void
  - onStatus(cb): () => void — ConnectionStatus lifecycle
  - getVersion(): Promise<string>
  - getStatus(): Promise<ParsedStatus>
  - arm() / disarm() / reboot() — UI-confirmed only
  - configureReconnect({ enabled, maxAttempts, delayMs })
  - getSentCommands() — test/smoke helper
- enumeratePorts() convenience
- Framing: LineBuffer, ResponseCollector, encodeCommand
- Parse: parseStatus, parseVersionLine
- Transport: SerialPortLike, factories, MockSerial, MOCK_PORT_PATH
- Types: PortInfo, ConnectionStatus, CliCommand, ParsedStatus, ...

Default baud: 115200.

## Smoke path

In protocol directory run the smoke script via package scripts after installing deps.

Flow: MockSerial connect; assert no commands sent; banner; version; status; help; explicit arm refuse check; disconnect.

## FW alignment notes (Lead-locked contract)

Source of truth: bobflight-firmware/src/drivers/cli.c (+ Lead lock).

Framing: USB CDC text; LF or CR ends command; trim spaces; replies CRLF.
Commands: exact lowercase, no args: help, version, status, arm, disarm, reboot.
Banner: BobFlight 0.1.0-skeleton ready (leading blank CRLF on wire).
version reply: BobFlight 0.1.0-skeleton
status keys: board, ir, mcu, gyro_ok, gyro_bind, dshot_bound, rx, mmio, arm, failsafe, loop
Arm fail-closed gate: gyro_ok:no, failsafe:ACTIVE only (arm:disarmed / mmio:denied are not Arm gates)
arm reply: armed OR arm refused (gyro unhealthy or failsafe)
disarm reply: always disarmed
reboot reply: reboot... then disconnect/reopen
unknown reply: unknown — try help

MockSerial emits these exact strings. Connect path sends zero CLI commands.

## Open questions for Lead

1. Should host treat the connect banner as a required handshake (fail connect if missing within N ms), or remain fire-and-forget as implemented?
2. After reboot, preferred reconnect policy (auto vs UI-driven) and idle timeout defaults for multi-line help/status?
3. Prefer keeping the native serial package optional forever, or make it a hard dependency once CI has native build images?
4. Should ParsedStatus.failClosed treat arm:disarmed alone as fail-closed for UI gating, or only when combined with gyro/failsafe (disarmed is the normal safe state)?
5. Any additional status keys planned before UI binds to ParsedStatus field names?

## Settings API (added)

- getSetting / setSetting / saveSettings / restoreDefaults / getAllSettings
- SETTINGS_KEYS, DEFAULT_SETTINGS, parse helpers; sendRaw; CliCommand unchanged
- Exact shapes: key=value; ok key=value; unknown key; set failed; saved; defaults restored
- Smoke script: smoke:settings
