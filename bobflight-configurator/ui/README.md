# BobFlight Configurator UI

Apache-2.0 clean-room React UI (Vite + React + TypeScript).

## Run

Start the Vite dev server from the monorepo, then open **http://127.0.0.1:5173** in Chrome/Edge.

## Connect

- Mock CDC toggle defaults on (CI).
- **Request USB port…** uses Protocol Web Serial ( / ) on localhost or https.
- Never auto-arms.

## Protocol

Uses  (Vite aliases to protocol source for browser ESM). Rates/PID use Protocol settings; local mockSettingsApi is fallback only.
