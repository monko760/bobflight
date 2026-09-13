# Props-off receiver switch proof

`switchbench2` preserves the observed low while passing through a middle switch position. Enter `bench_status` after an unsuccessful attempt: it reports the last session state or cancellation reason without starting/stopping motors. `waiting-for-high` means low was seen; `running-8-percent` means commanded output; `run-limit-return-switch-low` means the three-second limit was reached. Other reports identify receiver/USB loss, DShot health, calibration, throttle, invalid AUX input, session expiry or a mixer gap over 20ms. None of these guards are relaxed. CLI now also accepts the existing `receiver` diagnostic query.

This session-only test uses AUX1 low (<0 normalized) then high (>0.5) to send fixed 8% output to all four motors for at most three seconds. It does not flight-arm, use the mode-range ARM preview, or require healthy/calibrated gyro data. Sticks do not command motor speed or stabilization. Actual flight arming checks remain intact.

Remove ALL propellers. Connect USB, power the receiver/ESCs, and confirm AUX1 and throttle are low in Receiver. In the updated configurator CLI, enter `bench_switch` and confirm. Flip AUX1 high: four motors should run at fixed low output. Flip it low to stop. After the three-second cap, another low/high cycle is required. `bench_stop`, `disarm` and the existing motor-test Stop cancel the session. It expires after 60 seconds and must be explicitly enabled again. It is never saved or automatically restored.

Receiver freshness loss (existing 250ms limit), USB loss, DShot fault, manual calibration, invalid throttle/switch data, throttle over 5%, or a mixer gap over 20ms cancels the entire session and submits zero on the next mixer pass. Reconnection alone cannot restart output. The enabled session blocks existing configuration and motor-test mutations through `bench_motor_active`, including flash saves and UART remapping. A stop remains pending until zero is submitted. The normal watchdog handles a stuck main loop. ESC behavior after lost output still requires hardware verification.

After merge, in PowerShell:

```powershell
cd "C:\Users\Monko\BF ChatGPt"
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Update failed; stop here.' }
powershell -ExecutionPolicy Bypass -File ".\build-power-battery.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Build failed; stop here.' }
cd bobflight-configurator
npm.cmd install
npm.cmd run build
npm.cmd run dev
```

Flash `C:\Users\Monko\BF ChatGPt\bobflight-kakute-f7-hdv-power-battery-bench.hex`. Version must report `0.2.0-prototype-switchbench1`. Refresh Brave to load the new CLI command support. If a motor does not start at 8%, stop and report it; this test has no adjustable throttle. Firmware is bench-only, and this is not a flight test.
