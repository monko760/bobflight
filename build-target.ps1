# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
# Explicit target selection; builds and validates only. Never flashes hardware.
[CmdletBinding()]
param([string]$Target, [switch]$ListTargets, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$source = Join-Path $repo 'bobflight-firmware'
$pythonCmd = Get-Command python,python3,python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$pythonCmd) { throw 'Python 3 is required for target validation.' }
$python = $pythonCmd.Source
$registry = Join-Path $source 'scripts\target_registry.py'
if ($ListTargets) {
    & $python $registry list --json
    if ($LASTEXITCODE -ne 0) { throw 'Target catalog validation failed.' }
    return
}
if ([string]::IsNullOrWhiteSpace($Target)) { throw 'Select -Target <board-id>, or use -ListTargets. No implicit hardware target.' }
$resolvedText = & $python $registry resolve $Target --json --hardware
if ($LASTEXITCODE -ne 0) { throw 'Target selection rejected. No build or flash performed.' }
$resolved = ($resolvedText -join "`n") | ConvertFrom-Json
$board = $resolved.board.id
$mcu = $resolved.mcu.part
if ($ValidateOnly) { $resolvedText; return }
$toolRoot = Join-Path $env:USERPROFILE 'BF ChatGPt\tools'
$cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
$cmake = if ($cmakeCommand) { $cmakeCommand.Source } else { Join-Path $toolRoot 'cmake-3.31.6-windows-x86_64\bin\cmake.exe' }
$armCommand = Get-Command arm-none-eabi-gcc.exe -ErrorAction SilentlyContinue
$armDir = if ($armCommand) { Split-Path $armCommand.Source } else { Join-Path $toolRoot 'arm-gnu-toolchain-13.3.rel1-mingw-w64-i686-arm-none-eabi\bin' }
if (!(Test-Path -LiteralPath $cmake)) { throw 'CMake not found. Restore tools or add cmake.exe to PATH.' }
if (!(Test-Path -LiteralPath (Join-Path $armDir 'arm-none-eabi-gcc.exe'))) { throw 'ARM compiler not found. Restore tools or add it to PATH.' }
$env:PATH = $armDir + ';C:\TDM-GCC-64\bin;' + $env:PATH
if (!(Get-Command mingw32-make.exe -ErrorAction SilentlyContinue)) { throw 'mingw32-make.exe not found.' }
$build = Join-Path $source ('build-main-' + $board)
$cache = Join-Path $build 'CMakeCache.txt'
if (Test-Path -LiteralPath $cache) {
    $old = Get-Content -LiteralPath $cache -Raw
    $compilerOK = $old -match '(?m)^CMAKE_C_COMPILER:[^=]+=[^\r\n]*arm-none-eabi-gcc(?:\.exe)?\r?$'
    if (!$compilerOK -and $old -notmatch '(?m)^CMAKE_C_COMPILER:') {
        $recorded = @(Get-ChildItem -LiteralPath (Join-Path $build 'CMakeFiles') -Filter CMakeCCompiler.cmake -Recurse -File | ForEach-Object {
            $metadata = Get-Content -LiteralPath $_.FullName -Raw
            if ($metadata -match 'set\(CMAKE_C_COMPILER "([^"]+)"\)') { $Matches[1] }
        } | Select-Object -Unique)
        $compilerOK = $recorded.Count -eq 1 -and $recorded[0] -match '[/\\]arm-none-eabi-gcc(?:\.exe)?$'
    }
    if ($old -notmatch ('(?m)^BOBFLIGHT_BOARD:STRING=' + [regex]::Escape($board) + '\r?$') -or
        $old -notmatch ('(?m)^BOBFLIGHT_TARGET_MCU:STRING=' + [regex]::Escape($mcu) + '\r?$') -or !$compilerOK) {
        throw 'Build cache belongs to another board/MCU/compiler. Preserve it and use a fresh worktree.'
    }
}
& $cmake -S $source -B $build -G 'MinGW Makefiles' ('-DCMAKE_TOOLCHAIN_FILE=' + $resolved.toolchain) ('-DBOBFLIGHT_BOARD=' + $board) '-DBOBFLIGHT_HOST_SMOKE=OFF' '-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF' '-DBOBFLIGHT_PROVE_RESET=OFF' '-DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF'
if ($LASTEXITCODE -ne 0) { throw 'Configuration failed. Do not flash an older HEX.' }
& $cmake --build $build -j 4
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not flash an older HEX.' }
& $cmake --build $build --target check_bootloader_image
if ($LASTEXITCODE -ne 0) { throw 'Image validation failed. Do not flash an older HEX.' }
# Publish only after both independent image and target metadata checks succeed.
& $python (Join-Path $source 'scripts\publish_target_image.py') --target $board --hex (Join-Path $build 'bobflight.hex') --output $repo
if ($LASTEXITCODE -ne 0) { throw 'Artifact publication failed. Do not use an older artifact.' }
Write-Host ('BUILD COMPLETE: ' + $board + ' / ' + $mcu + ' (' + $resolved.board.support + '). No controller was flashed.')
Write-Host 'Keep props removed for hardware installation and checks. A successful build is not hardware qualification.'
