# Sensor-only TMOTORF7V2 build. Never flashes a controller.
$ErrorActionPreference = 'Stop'
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
$build = Join-Path $source 'build-tmotorf7v2-sensors'
$cache = Join-Path $build 'CMakeCache.txt'
if (Test-Path -LiteralPath $cache) {
    $old = Get-Content -LiteralPath $cache -Raw
    if ($old -notmatch '(?m)^BOBFLIGHT_BOARD:STRING=tmotor_f7_v2\r?$' -or $old -notmatch '(?m)^BOBFLIGHT_TARGET_MCU:STRING=STM32F722\r?$' -or $old -notmatch '(?m)^CMAKE_C_COMPILER:[^=]+=[^\r\n]*arm-none-eabi-gcc(?:\.exe)?\r?$') {
        throw 'Build cache belongs to a different target/compiler. Preserve it and use a fresh worktree; do not force the build.'
    }
}
& $cmake -S $source -B $build -G 'MinGW Makefiles' '-DCMAKE_TOOLCHAIN_FILE=cmake/stm32f722.cmake' '-DBOBFLIGHT_BOARD=tmotor_f7_v2' '-DBOBFLIGHT_HOST_SMOKE=OFF' '-DBOBFLIGHT_FLIGHT_ENABLE=OFF' '-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF' '-DBOBFLIGHT_PROVE_RESET=OFF' '-DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF'
if ($LASTEXITCODE -ne 0) { throw 'TMOTORF7V2 configuration failed. Do not flash an older HEX.' }
& $cmake --build $build -j 4
if ($LASTEXITCODE -ne 0) { throw 'TMOTORF7V2 build/image validation failed. Do not flash an older HEX.' }
# Recheck the image even if CMake did not need to relink this time.
& $cmake --build $build --target check_tmotor_image
if ($LASTEXITCODE -ne 0) { throw 'TMOTORF7V2 image validation failed.' }
$hex = Join-Path $repo 'bobflight-tmotorf7v2-sensors-bench.hex'
Copy-Item -LiteralPath (Join-Path $build 'bobflight.hex') -Destination $hex -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $hex
Write-Host 'BUILD CHECKPOINT: sensor-only image built and bounds/version checked. No controller was flashed.'
Write-Host 'Expected firmware: 0.2.0-prototype-tmotorf7v2-sensor2-bl1-calstore1-piddiag2; board tmotor_f7_v2.'
Write-Host 'Read BOOTLOADER.md (Holybro first) and TMOTORF7V2.md before installation. Motors, flight and F722 configuration saving are unavailable.'
