# Verified starting point

User confirmed USB connection and live sensor display on the Kakute F7 HDV.

Recovery image: bobflight-kakute-f7-hdv-sensor-telemetry.hex (local, untracked)
SHA256: BFE36A4F18A483B4903C43B7BD8038EE2A05BD35D365383326A5EE0979AA0924

Key fixes: start watchdog before waiting for its register updates; increase
USB CDC TX buffer to 2048 bytes so current status responses fit.

Normal initialization enabled; flight arming disabled in the tested bench build.
MPU6000 telemetry and gyro calibration command are present. Accelerometer
calibration and comprehensive failsafe validation remain outstanding.
This baseline is not flight-qualified. HEX-to-source reproducibility has not
been independently verified; the image hash identifies the saved artifact.
