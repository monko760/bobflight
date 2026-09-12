# Contributing — BobFlight Configurator

Thanks for helping. This repo is **clean-room Apache-2.0**. It is **not** a fork of Betaflight Configurator.

## Ground rules

1. Propose large UX/protocol changes in an Issue/Discussion first.
2. Keep PRs small and reviewable.
3. Include repro steps or screenshots for UI changes; link protocol fixtures for link-layer changes.
4. Coordinate firmware-facing MSP/command changes with the firmware team.

## DCO

Every commit must be signed off:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s` ([DCO 1.1](https://developercertificate.org/)). Contributions are under **Apache-2.0**.

## Clean-room attestation (required)

```markdown
### Clean-room attestation
- [ ] I did **not** copy or adapt source from Betaflight Configurator (`betaflight/betaflight-configurator`) or other GPLv3 configurator / GCS trees.
- [ ] I did **not** use those GPL sources as a reference while authoring this patch (no “read BF Configurator then rewrite”).
- [ ] Protocol/UI behavior was taken from public specs, BobFlight docs, or black-box interop against a running FC — not from porting GPL configurator code.
- [ ] This PR does not vendor GPL configurator assets (HTML/JS/CSS/SVG/locale dumps, etc.).
```

## Rejected contributions

| Do not submit | Why |
|---------------|-----|
| Pasted or lightly edited Betaflight Configurator code/assets | Breaks clean-room / Apache posture |
| “Port this tab/page from BF Configurator” derived from GPL trees | Same |
| Stripped GPL headers presented as Apache | Misleading |
| Names/logos/USB strings implying official Betaflight | Trademark / confusion |
| Expanding firmware F7 V2 GPL pin-IR patterns into this app | Exception does not apply here |

## PR checklist

- [ ] DCO (`git commit -s`)
- [ ] Clean-room attestation completed
- [ ] Tests / lint / build green (as applicable)
- [ ] No secrets; no vendored GPL configurator trees

## Review and merge

Protected default branch; Configurator Lead / CODEOWNERS merge only.
