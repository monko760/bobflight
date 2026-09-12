# BobFlight Configurator

Apache-2.0 clean-room configurator for BobFlight flight controllers.

Independent implementation. Not a fork of Betaflight Configurator. Do not
copy or paste GPL MSP trees or Betaflight Configurator sources into this repo.
See NOTICE.

## Stack

- Language: TypeScript
- Monorepo: npm workspaces (protocol/ + ui/)
- UI: Vite + React + TypeScript (UI Lead choice; Web Serial / Electron later)
- Transport MVP: USB CCD serial CLI (text), plus mock transport for demos

## MVP scope (locked)

### CLI commands (exact names)

help | version | status | arm | disarm | reboot

No synonyms. No MSP tabs / PID tuning screens in MVP.

### Screens

1. Connect - port + baud (+ mock toggle)
2. Status - live parsed status key:value panel; arm/disarm with confirm stubs
3. CLI console - raw command I/O

Rules:

- Never auto-arm on connect
- Surface fail-closed reasons from status (e.g. gyro_ok:no, arm:disarmed, failsafe:ACTIVE, mmio:denied)
- reboot disconnects the session
### FW mock contract (demo mode)

On connect, mock emits banner:

    BobFlight 0.1.0-skeleton ready

status returns CRLF key:value lines. arm when blocked returns a refuse string.
reboot returns rebooting... and disconnects. Shapes follow FW Lead responses.

## Layout

    bobflight-configurator/
      LICENSE NOTICE GOVERNANCE.md CONTRIBUTING.md SECURITY.md
      README.md package.json tsconfig.base.json
      protocol/
      ui/

## Quick start (mock mode)

From repo root: install workspaces, then build, then start the Vite UI.
Default UI port is 5173. Use mock connect without hardware.

## License

Apache-2.0. See LICENSE and NOTICE.

## UI run steps

From repo root install workspaces, build protocol and ui, then start Vite on port 5173. Smoke script verifies mock connect/version/status.

- Install at repo root
- Build protocol package
- Build ui package
- Run ui smoke for mockHost assertions
- Run ui dev server (localhost:5173)
