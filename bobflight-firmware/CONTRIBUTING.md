# Contributing

Thanks for helping. This is a **clean-room, Apache-2.0** project (Path B). It is **not** a Betaflight fork. Please read this before opening a PR.

## Ground rules

1. **Propose before large features** — open a Discussion or Issue first for design changes that affect flight behavior, protocols, or board schema.
2. **Small, reviewable PRs** — one concern per PR when practical.
3. **Tests / evidence** — firmware flight-affecting changes should include bench notes, unit tests, and/or blackbox/log evidence when available.
4. **Code of conduct** — be respectful (see `CODE_OF_CONDUCT.md` when published).

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s`. By signing off, you certify the [Developer Certificate of Origin](https://developercertificate.org/) (DCO 1.1): you have the right to submit the work under the project’s license (Apache-2.0).

PRs without a valid DCO will not be merged. CI may enforce this with a DCO bot.

## Clean-room attestation (required)

In every PR description, include this checkbox block (all must be checked):

```markdown
### Clean-room attestation
- [ ] I did **not** copy or adapt source from Betaflight, INAV, EmuFlight, Cleanflight, or other GPLv3 flight-controller trees (including `betaflight/config` board `config.h` / target files).
- [ ] I did **not** use those GPL sources as a reference while authoring this patch (no “read config.h then rewrite”).
- [ ] Board/pin data (if any) comes from OEM schematics, datasheets, or independent bring-up — or from this project’s **owned** board schema / reviewed import output — not from pasted GPL target files.
- [ ] I understand optional Betaflight config **import tools** treat BF files as external GPLv3 **input**; this PR does not vendor or relicense those files as Apache-2.0.
```

Maintainers will close PRs that omit attestation or that clearly paste GPL material.

## Rejected contributions (non-exhaustive)

| Do not submit | Why |
|---------------|-----|
| Pasted or lightly edited Betaflight / related GPL `config.h` or firmware sources | Violates clean-room / Apache posture |
| “Port this PID/filter from BF” patches derived from GPL trees | Same |
| Stripped GPL headers presented as original work | Misleading and non-compliant |
| Trademark-confusing names, logos, or USB strings implying official Betaflight | Branding / confusion |

**Board targets:** add boards only in this project’s owned schema. Do **not** open PRs that drop raw `betaflight/config` files into the tree. An optional importer may *read* user-supplied BF defs as data; its output still needs human review and attestation before landing in `board-defs` / firmware.

## Repo-specific notes

### `firmware`
- Follow coding style and build instructions in the repo README.
- Prefer changes behind clear module boundaries; document new protocols in `docs`.

### `tools` (CLI)
- Keep BF-config parsers **optional** and clearly labeled; never commit GPL config corpora into this repo.
- Parser tests should prefer synthetic fixtures; if GPL samples are required for private testing, keep them out of Apache release artifacts (see project OSS notes).

### `docs`
- Specs are the clean-team source of truth. Do not paste large GPL source excerpts into docs.

## PR checklist

- [ ] DCO sign-off on all commits (`git commit -s`)
- [ ] Clean-room attestation block completed
- [ ] Tests / build green (as applicable)
- [ ] Docs updated if behavior or schema changed
- [ ] No secrets, credentials, or customer blobs

## Review and merge

- Default branch is protected: PR + maintainer/`CODEOWNERS` review + CI.
- **Only maintainers merge.** Roadmap priority is set by the project lead (`GOVERNANCE.md`).
