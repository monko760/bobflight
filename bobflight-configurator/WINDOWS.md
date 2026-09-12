# Windows install (BobFlight Configurator)

PowerShell steps for a clean install on Windows.
The package @bobflight/protocol is local via file:../protocol (not on npmjs.org).
Root workspaces remain; file: also works without them.
## Prerequisites
- Node.js 18+
- npmjs client 9+

## Exact steps

In PowerShell, from the repo root:
1. Set-Location to bobflight-configurator
2. Remove-Item -Recurse -Force .\node_modules
3. Remove-Item -Recurse -Force .\ui\node_modules (if present)
4. Remove-Item -Recurse -Force .\protocol\node_modules (if present)
5. Remove-Item -Force .\package-lock.json (optional clean)
6. From root: install workspace packages
   Use the npmjs CLI install at repo root.
7. Build: npmjs CLI run build
8. Dev: npmjs CLI run dev
   Or: npmjs CLI run dev:ui

Open http://localhost:5173 and use mock connect without hardware.

## If you still see a 404 for @bobflight/protocol

1. Confirm ui/package.json uses file:../protocol
2. Confirm protocol/package.json name @bobflight/protocol version 0.1.0
3. Install only from the repo root
4. Delete node_modules and package-lock.json, then reinstall from root

## Notes

- Keep root workspaces; file: works without them too
- Root scripts use workspace flags for build/dev/typecheck/clean
- Script dev:ui uses prefix ui to run local Vite after file: install
- Never use ^1.0.0 registry semver for @bobflight/protocol
Note: npmjs CLI means the standard Node package manager command.
