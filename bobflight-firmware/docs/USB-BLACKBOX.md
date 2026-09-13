# USB bench recordings

The configurator Blackbox tab records existing read-only CLI responses. No firmware update is needed on the current merged firmware. This is not an onboard flight recorder or a Betaflight Blackbox Explorer-compatible file.

Connect, open Blackbox, choose sources, and Start recording. Move the board or transmitter controls, Stop, then download JSON (complete recording) or CSV (one field per row). Version is queried once at the beginning. Sensors, receiver, power, status and PID diagnostics are queried sequentially. At most five requests start per second across all selected sources; slow responses reduce the rate. There is never a queued backlog from the recorder. Values from different requests are not synchronized.

Recording never starts motors, arms, saves settings or starts PID diagnostics. To record an existing PID diagnostic session, start it separately in CLI before entering Blackbox. Its normal firmware timeout and stop conditions still apply. Inactive, unsupported and error replies are retained, not replaced by invented values. A mock connection records mock data.

Leaving Blackbox, losing the connection, a request failure, ten minutes, 5,000 replies or 8 MiB of reply text stops capture. In-flight replies after Stop are discarded. Data remains across configurator tab changes, but not browser reload/close; download before leaving the application. A replacement checkbox prevents accidentally starting over. Browser unload warnings are best effort, not disk backup.

JSON schema 1 identifies `bobflight-usb-bench`, UTC session start, stop reason and samples with command, browser-monotonic request/receive milliseconds and raw reply or error. Raw replies preserve firmware fields, units, validity and sequence counters where provided. CSV has command/requested_ms/received_ms/field/value columns; vector values remain together. Formula-like text is neutralized for spreadsheets. This transport envelope must not be confused with future MCU capture timestamps.

## Acceptance on the board

With props removed, record ten seconds of board motion and transmitter movement. Verify downloaded replies change, timestamps increase and firmware identity matches. Stop and verify the reply count stops; switch tabs and return to confirm the recording remains. Start another recording after downloading, disconnect USB, and verify capture stops with existing data still downloadable. This software increment has automated recorder tests and a production build; hardware acceptance remains owner-side.

## Onboard follow-up

Use a separate MCU-timestamped sample format and bounded queue. Establish the actual board's storage wiring and capability before implementing a nonblocking SD backend. Log overflow and timing gaps explicitly, retain configuration flash separately, and test media removal/full/error handling without delaying control work. USB snapshots are useful for bench diagnosis, not PID frequency-response analysis or flight qualification.
