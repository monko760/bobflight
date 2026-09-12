# Security policy — BobFlight Configurator

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Development `main` | Best effort |
| Older releases | No (unless announced) |

## Reporting

**Do not** open a public GitHub Issue for vulnerabilities.

1. **GitHub Private Vulnerability Reporting** on this repository (preferred, when enabled), or
2. Email: **security@BobFlight.example** *(replace before public launch)*

Include: version/commit, impact (e.g. XSS, local file access, malicious FC payload handling), repro steps, and whether already public.

## Response targets (goals)

- Acknowledgement within **3 business days**
- Initial assessment within **7 business days**

## Notes for this app

- Treat FC-provided data as **untrusted input** (XSS, path traversal, prototype pollution).
- Flash/firmware-update flows are high risk — validate images and never auto-run untrusted binaries.
- Good-faith research appreciated; avoid privacy violations and data that is not yours.
