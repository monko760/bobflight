# Single main-image validation — 2026-09-15

Baseline: `0f9639cb2c55b3b41da8d4918eb745bf91ece25b` (merged PR #37).

## Final integrated software checks

- **82/82 native tests on each of dummy, Kakute and TMotor** (246 test executions). Includes timing/PID elapsed-time, sensor freshness, configured arming, failsafe, bench mutual exclusion, bootloader, storage and the new legacy AUX migration test. The former 83-test profile matrix had two duplicate/profile-specific variants; those have been retired with the profile split, rather than reported as unchanged coverage.
- **45 validation steps passed**, including both actual Cortex-M7 cross-builds (Kakute main and TMotor sensor-only), HEX vector/bounds/version validators, ELF32/ARM checks, 23 configurator/protocol/install/build steps, and three actual firmware→configurator contracts (Ports/Modes, storage/export, PID diagnostic framing).
- Separate single-entrypoint checks verified stale ON/OFF profile refusal, actual MCU compile definitions, compiler-preprocessed status selection, and static Windows script invariants.
- The new migration test uses the production codec with a host store and faithful manual-only control stubs. It injects legacy source byte 54, preserves the saved mode and every other payload byte, verifies no implicit flash write, verifies repeated-boot notice and explicit-save cleanup, rejects both failing manual-source paths, and rejects an invalid mode. Real runtime source refusal is also covered by the host CLI contract. This is not a physical flash test.

## Reproduce

From the repository root (native compiler, CMake, Python and Node installed):

```sh
cmake -S bobflight-firmware -B bobflight-firmware/build-contract -DBOBFLIGHT_BOARD=kakute_f7_hdv
cmake --build bobflight-firmware/build-contract -j2
ctest --test-dir bobflight-firmware/build-contract --output-on-failure
cd bobflight-configurator
npm ci --no-audit --no-fund
npm run typecheck
npm run build
node ../.github/scripts/ports-modes-contract.cjs
node ../.github/scripts/storage-contract.cjs
node ../.github/scripts/pid-diagnostics-contract.cjs
```

Repeat the native build in separate fresh directories with board `dummy` and `tmotor_f7_v2`. Full configurator commands are also in `.github/workflows/ci.yml`; the local run additionally included UI smoke. Windows build/install/verification commands are in [MAIN-BUILD.md](MAIN-BUILD.md), using `npm.cmd` and the main script.

Cross-build (ARM GNU toolchain installed; never flashes):

```sh
cmake -S bobflight-firmware -B bobflight-firmware/build-main-kakute_f7_hdv -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake -DBOBFLIGHT_BOARD=kakute_f7_hdv -DBOBFLIGHT_HOST_SMOKE=OFF -DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF
cmake --build bobflight-firmware/build-main-kakute_f7_hdv -j2
cmake --build bobflight-firmware/build-main-kakute_f7_hdv --target check_bootloader_image
```

## Limits and remaining hardware acceptance

No board was accessed or flashed. Windows PowerShell was inspected, not executed here. Target `bl`, new-image USB recovery, real Save/full power-cycle restoration, motor ordering and props-off PID response still require local physical acceptance. The existing USB Blackbox tab captures asynchronous snapshots, not armed high-rate PID terms or RPM. No flight qualification is asserted. PR CI is separate from these local results and must report on the published commit.

## Exact local cross-build hashes

These identify the local toolchain outputs, not a promise of byte-identical output with another compiler version.

- `main-kakute_f7_hdv` HEX SHA-256: `73aa2d0af73e7a3a36601723e333827149eb6c420e82a78ba2a3d6d6cb9d5859`
- `sensor-tmotor_f7_v2` HEX SHA-256: `c75c8863c34aa34a40b9e6107335263ca578b00c1b6707b31dd55d53bc462fba`
