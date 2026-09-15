# Closed-loop development: now part of the main image

There is no separate Kakute closed-loop build anymore. Use [MAIN-BUILD.md](MAIN-BUILD.md) and `build-main.ps1` for the single image that supports configuration Save, diagnostics and props-off armed PID testing.

The former `-PropsRemoved`, `-AcknowledgeUnqualifiedFirmware` and `BOBFLIGHT_FLIGHT_ENABLE` build-profile switches are retired. Props still stay off for this milestone, and all normal runtime arming/health/failsafe guards remain. Acro retains PR #37 gyro-only readiness.

Do not use earlier versions of this page as installation instructions; notably, low throttle does not itself disarm the controller, and a statically tilted Acro frame is not expected to self-level.
