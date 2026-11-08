# Pinned ARM CI dependencies

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Scope

This change is confined to `.github/`. It does not modify firmware, board files,
configurator code, existing Python requirements or build/test commands. It does
not change PR #98's Defaults work.

Run 40443507751 timed out in Matek's combined `Install tools` step. The available
step annotation does not isolate apt versus pip. PR #101 bounded that failure,
but the combined step still obscured the failing dependency stage. This change
removes apt from the three ARM jobs and separates Python setup explicitly.

## ARM toolchain

Kakute, Matek and F4-component jobs use Ubuntu 24.04 x86_64 and the local
`setup-arm-toolchain` composite action:

- Official Arm GNU **14.2.rel1** (compiler **14.2.1**).
- Fixed HTTPS download URL and SHA-256 in `scripts/setup-arm-toolchain.sh`.
- Checksum source:
  <https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz.sha256asc>
- Expected archive SHA-256:
  `62a63b981fe391a9cbad7ef51b17e49aeaa3e7b0d029b36ca1e9c3b2a9b78823`.
- Cache key includes OS, architecture and installer content hash. No fallback
  restore keys can select a different installer version/policy.
- Only the compressed archive is cached. Cache hits are checksum-verified too,
  then extracted into a fresh runner temporary directory, not trusted as an
  executable tree. A corrupt cache is replaced by a verified download; a bad
  download fails closed before extraction or PATH export.
- Require gcc, g++, objcopy, objdump, readelf, size, nm and ar. Verify the compiler
  version and Cortex-M4/M7 hard-float `nosys.specs`, libc, libm, libnosys and libgcc.
- Cache download segments have a two-minute limit. Curl uses HTTPS-only redirects,
  bounded connection/transfer/retry limits. Setup retains a ten-minute step limit
  and each ARM job retains its twenty-minute overall limit.

This pins the compiler rather than silently accepting whatever version an apt
mirror currently supplies. It does **not** claim bit-for-bit equivalence to
older compiler output or pin every runner package. Binaries can change with the
compiler version; passing models/builds is not flight qualification. No generated
firmware image from this CI change is being offered for hardware flashing.

GCC is an external build tool, not source copied into BobFlight. Its existing
licensing/runtime-library obligations still apply. This is not a full project
provenance or GPL-contamination audit.

## Python model dependencies

Both Matek and F4 reuse the existing
`bobflight-firmware/tests/f4-component-requirements.txt` without changing it:
`unicorn==2.1.4`, `pyelftools==0.32`. Its filename is historical; the same packages
support both ARM model suites.

`setup-python` selects the existing F4 Python 3.11 family for both jobs and caches
pip downloads using that requirements file. Python patch/security updates remain
allowed. A separate five-minute install step permits binary wheels only, uses
bounded pip timeouts/retries, runs `pip check`, and prints dependency versions.
There is no unrelated pip upgrade or added PyYAML dependency; board tooling uses
the standard library. Python setup has its own three-minute limit.

The host, configurator and Windows jobs are unchanged. The board-definitions job
adds only the offline installer regression test.

## Validation on source 46bda52 plus this patch

Locally executed, using the actual checksum-pinned Arm compiler and a fresh Python
3.11 virtual environment with the pinned model requirements:

- Eight offline installer cases: cold/warm cache, fresh extraction despite a
  modified earlier executable tree, corrupt cache repair, bad checksum rejection,
  failed download cleanup, compiler-version mismatch, missing library/tool and
  unsupported platform.
- Real cold download and real warm-cache installation. Warm reuse required no
  new download; both compiler and multilib checks succeeded.
- Six F722 flash-model tests.
- Matek cross-build and `check_bootloader_image` sparse-HEX verification.
- Kakute cross-build.
- Both F4 component compile commands and all eleven existing ARM model scripts
  from CI: **93 F4 tests**, **99 total ARM model tests** with the F722 suite.
- YAML validation, `bash -n`, actionlint 1.7.12, and a structural comparison that
  all existing build/test commands and unaffected jobs remain identical.

A focused read-only architecture review supported separating dependencies,
checksum-pinning/caching the official toolchain and checking newlib completeness.
The implementation also verifies restored archives rather than trusting cache
contents. Reviewer's timing estimates and attribution to a particular apt
subcommand were not treated as established evidence.

Hosted GitHub cache cold/warm behavior and full green CI still require the PR's
actual run. Local builds are not a substitute for that final integration check.

## Updating the pin

Update version, compiler-version expectation and official checksum together in
`setup-arm-toolchain.sh`. Its content-hashed cache key then changes automatically.
Re-run the installer tests, cold/warm installation, Matek storage/sparse-image
checks, Kakute build, and complete F4 job commands. Do not relax verification or
skip failing models to accommodate a compiler change.
