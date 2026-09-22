# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Canonical root build script for BobFlight Kakute F7 HDV image.
# Builds single supported Kakute hardware image. Never flashes a controller automatically.
# Usage: .\build-main.ps1

$ErrorActionPreference = 'Stop'
$Board = 'kakute_f7_hdv'
$mcu = 'STM32F745'
$toolchain = 'cmake/stm32f745.cmake'

$repo = $PSScriptRoot
$toolRoot = Join-Path $env:USERPROFILE 'BF ChatGPt\tools'
$cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
$cmake = if ($cmakeCommand) { $cmakeCommand.Source } else { Join-Path $toolRoot 'cmake-3.31.6-windows-x86_64\bin\cmake.exe' }
$armCommand = Get-Command arm-none-eabi-gcc.exe -ErrorAction SilentlyContinue
$armDir = if ($armCommand) { Split-Path $armCommand.Source } else { Join-Path $toolRoot 'arm-gnu-toolchain-13.3.rel1-mingw-w64-i686-arm-none-eabi\bin' }

if (!(Test-Path -LiteralPath $cmake)) { throw 'CMake not found. Restore the existing tools folder or put cmake.exe on PATH.' }
if (!(Test-Path -LiteralPath (Join-Path $armDir 'arm-none-eabi-gcc.exe'))) { throw 'ARM compiler not found. Restore the existing tools folder or put arm-none-eabi-gcc.exe on PATH.' }

$env:PATH = $armDir + ';C:\TDM-GCC-64\bin;' + $env:PATH
if (!(Get-Command mingw32-make.exe -ErrorAction SilentlyContinue)) { throw 'mingw32-make.exe not found. Restore the existing TDM-GCC tools or add them to PATH.' }

$source = Join-Path $repo 'bobflight-firmware'
$build = Join-Path $source ("build-main-" + $Board)
$cache = Join-Path $build 'CMakeCache.txt'

if (Test-Path -LiteralPath $cache) {
    $old = Get-Content -LiteralPath $cache -Raw
    # Known ARM compiler/cache identity guard from build-bootloader-bench.ps1
    $compilerOK = $old -match '(?m)^CMAKE_C_COMPILER:[^=]+=[^\r\n]*arm-none-eabi-gcc(?:\.exe)?\r?$'
    if (!$compilerOK -and $old -notmatch '(?m)^CMAKE_C_COMPILER:') {
        $recorded = @(Get-ChildItem -LiteralPath (Join-Path $build 'CMakeFiles') -Filter CMakeCCompiler.cmake -Recurse -File | ForEach-Object {
            $metadata = Get-Content -LiteralPath $_.FullName -Raw
            if ($metadata -match 'set\(CMAKE_C_COMPILER "([^"]+)"\)') { $Matches[1] }
        } | Select-Object -Unique)
        $compilerOK = $recorded.Count -eq 1 -and $recorded[0] -match '[/\\]arm-none-eabi-gcc(?:\.exe)?$'
    }
    if ($old -notmatch ("(?m)^BOBFLIGHT_BOARD:STRING=" + $Board + "\r?$") -or $old -notmatch ("(?m)^BOBFLIGHT_TARGET_MCU:STRING=" + $mcu + "\r?$") -or !$compilerOK) {
        throw 'Build cache belongs to a different target/compiler. Preserve it and use a fresh worktree; do not force the build.'
    }
}

& $cmake -S $source -B $build -G 'MinGW Makefiles' ("-DCMAKE_TOOLCHAIN_FILE=" + $toolchain) ("-DBOBFLIGHT_BOARD=" + $Board) '-DBOBFLIGHT_HOST_SMOKE=OFF' '-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF' '-DBOBFLIGHT_PROVE_RESET=OFF' '-DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF'
if ($LASTEXITCODE -ne 0) { throw 'F7 configuration failed. Do not flash an older HEX.' }

& $cmake --build $build -j 4
if ($LASTEXITCODE -ne 0) { throw 'F7 build/image validation failed. Do not flash an older HEX.' }

# Recheck the image even if CMake did not need to relink this time.
& $cmake --build $build --target check_bootloader_image
if ($LASTEXITCODE -ne 0) { throw 'F7 image validation failed.' }

$hex = Join-Path $repo ("bobflight-" + $Board + "-main.hex")
Copy-Item -LiteralPath (Join-Path $build 'bobflight.hex') -Destination $hex -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $hex

Write-Host "BUILD COMPLETE: Single supported Kakute image built at $hex. No controller was flashed."
$expectedVersion = '0.2.0-prototype-flightdev1-bl1-calstore2-piddiag2-sdprobe2-bbl1'
Write-Host "Expected firmware: $expectedVersion; board $Board."
Write-Host 'Keep props removed when flashing and testing on bench.'
