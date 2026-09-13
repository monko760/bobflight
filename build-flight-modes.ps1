$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$toolRoot = Join-Path $env:USERPROFILE 'BF ChatGPt\tools'
$cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
$cmake = if ($cmakeCommand) { $cmakeCommand.Source } else { Join-Path $toolRoot 'cmake-3.31.6-windows-x86_64\bin\cmake.exe' }
$armCommand = Get-Command arm-none-eabi-gcc.exe -ErrorAction SilentlyContinue
$armDir = if ($armCommand) { Split-Path $armCommand.Source } else { Join-Path $toolRoot 'arm-gnu-toolchain-13.3.rel1-mingw-w64-i686-arm-none-eabi\bin' }
if (!(Test-Path -LiteralPath $cmake)) { throw 'CMake not found. Install CMake or restore the existing tools folder.' }
if (!(Test-Path -LiteralPath (Join-Path $armDir 'arm-none-eabi-gcc.exe'))) { throw 'ARM compiler not found. Restore the existing tools folder.' }
$env:PATH = $armDir + ';C:\TDM-GCC-64\bin;' + $env:PATH
$source = Join-Path $repo 'bobflight-firmware'
$build = Join-Path $source 'build-flight-modes-kakute'
& $cmake -S $source -B $build -G 'MinGW Makefiles' '-DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake' '-DBOBFLIGHT_BOARD=kakute_f7_hdv' '-DBOBFLIGHT_FLIGHT_ENABLE=OFF' '-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF' '-DBOBFLIGHT_HOST_SMOKE=OFF'
if ($LASTEXITCODE -ne 0) { throw 'Firmware configuration failed.' }
& $cmake --build $build -j 4
if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed.' }
$hex = Join-Path $repo 'bobflight-kakute-f7-hdv-flight-modes-bench.hex'
Copy-Item -LiteralPath (Join-Path $build 'bobflight.hex') -Destination $hex
Get-FileHash -LiteralPath $hex -Algorithm SHA256
Write-Host "Built bench HEX: $hex"
