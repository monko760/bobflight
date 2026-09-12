# Security policy

## Supported versions

Security fixes are applied to the **current release** of each published repo (`firmware`, `tools`, `docs` as applicable) and, at maintainer discretion, to the prior stable tag.

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Development `main` | Best effort |
| Older releases | No (unless announced) |

## Reporting a vulnerability

**Do not** open a public GitHub Issue for security vulnerabilities.

Please report privately via:

1. **GitHub Private Vulnerability Reporting** on the affected repository (preferred, when enabled), or
2. Email: **security@BobFlight.example** *(replace with the real address before public launch)*

Include:

- Affected repo and version / commit
- Description and impact (e.g. RCE on companion tool, unsafe flash path, auth bypass)
- Reproduction steps or proof-of-concept
- Whether the issue is already public

## Response targets (goals, not SLAs)

- Acknowledgement within **3 business days**
- Initial severity assessment within **7 business days**
- Coordinated fix and disclosure timing agreed with the reporter when practical

## Safe harbor

We appreciate good-faith research. Avoid privacy violations, service degradation, and access to data that is not yours. We will not pursue legal action against good-faith reporters who follow this policy.

## Flight safety note

Firmware bugs can destroy aircraft or injure people. If your report affects arming, motor output, failsafe, or configuration that could cause unexpected spin-up, mark it **URGENT** in the subject line.
