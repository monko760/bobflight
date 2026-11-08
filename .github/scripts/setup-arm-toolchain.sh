#!/usr/bin/env bash
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.
# CI only. Cache the official archive, never a previously extracted executable tree.
set -euo pipefail

VERSION='14.2.rel1'
GCC_VERSION='14.2.1'
ARCHIVE_NAME="arm-gnu-toolchain-${VERSION}-x86_64-arm-none-eabi.tar.xz"
URL="https://developer.arm.com/-/media/Files/downloads/gnu/${VERSION}/binrel/${ARCHIVE_NAME}"
# Official companion checksum, verified when this version was selected:
# https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi.tar.xz.sha256asc
SHA256='62a63b981fe391a9cbad7ef51b17e49aeaa3e7b0d029b36ca1e9c3b2a9b78823'

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This CI toolchain installer supports Linux x86_64 only.' >&2
  exit 1
fi
archive="${RUNNER_TOOL_CACHE:?}/bobflight-arm-gnu/arm-gnu-toolchain.tar.xz"
mkdir -p "$(dirname "$archive")" "${RUNNER_TEMP:?}"
download=''
install_root=''
success=false
cleanup() {
  [[ -z "$download" ]] || rm -f -- "$download"
  if [[ "$success" != true && -n "$install_root" ]]; then rm -rf -- "$install_root"; fi
}
trap cleanup EXIT
verify() { printf '%s  %s\n' "$SHA256" "$1" | sha256sum --check --status; }

if [[ -f "$archive" ]] && ! verify "$archive"; then
  echo 'Cached ARM archive failed checksum; replacing it with a verified download.' >&2
  rm -f -- "$archive"
fi
if [[ ! -f "$archive" ]]; then
  echo "Downloading pinned ARM GNU ${VERSION} from developer.arm.com"
  download=$(mktemp "${archive}.download.XXXXXX")
  # Retry only within a bounded budget. The caller also has a ten-minute limit.
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 150 --retry 2 --retry-delay 2 \
    --retry-max-time 360 --retry-connrefused --output "$download" "$URL"
  if ! verify "$download"; then
    echo 'Downloaded ARM archive failed SHA-256 verification; refusing extraction.' >&2
    exit 1
  fi
  mv -- "$download" "$archive"
  download=''
else
  echo "Using checksum-verified cached ARM GNU ${VERSION} archive"
fi
# Always verify again, including cache hits. A cache hit is not a trust decision.
verify "$archive"
install_root=$(mktemp -d "${RUNNER_TEMP}/bobflight-arm-gnu.XXXXXX")
tar --extract --xz --file "$archive" --directory "$install_root" --strip-components=1 --no-same-owner
for tool in gcc g++ objcopy objdump readelf size nm ar; do
  if [[ ! -x "${install_root}/bin/arm-none-eabi-${tool}" ]]; then
    echo "Required compiler tool missing: arm-none-eabi-${tool}" >&2
    exit 1
  fi
done
gcc="${install_root}/bin/arm-none-eabi-gcc"
if [[ "$("$gcc" -dumpfullversion)" != "$GCC_VERSION" ]]; then
  echo 'Extracted compiler version does not match the pinned release.' >&2
  exit 1
fi
# Replacing apt must not accidentally omit the newlib multilibs or nosys.specs.
for cpu in cortex-m4 cortex-m7; do
  fpu=fpv4-sp-d16
  [[ "$cpu" != cortex-m7 ]] || fpu=fpv5-sp-d16
  for library in nosys.specs libc.a libm.a libnosys.a libgcc.a; do
    resolved=$("$gcc" -mcpu="$cpu" -mthumb -mfpu="$fpu" -mfloat-abi=hard "-print-file-name=$library")
    if [[ "$resolved" == "$library" || ! -f "$resolved" ]]; then
      echo "Required $cpu library missing: $library" >&2
      exit 1
    fi
  done
done
"$gcc" --version
printf 'Verified Cortex-M4/M7 hard-float newlib, libgcc and nosys.specs.\n'
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "${install_root}/bin" >> "$GITHUB_PATH"; fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'bin=%s\nversion=%s\n' "${install_root}/bin" "$VERSION" >> "$GITHUB_OUTPUT"
fi
printf 'ARM toolchain bin: %s\n' "${install_root}/bin"
success=true
