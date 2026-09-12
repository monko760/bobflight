# BobFlight architecture (skeleton)

Clean-room Apache-2.0 flight-controller firmware (**Path B**). Not a Betaflight
fork. Layout names are owned (`app`, `sched`, `flight`, `drivers`, `hal`, `board`).

## Layers

```
app/          init order + main → scheduler_run()
sched/        cooperative cascade + background queue
flight/       pid, mixer, rates, arming, failsafe
drivers/      gyro, dshot, rx (CRSF), cli, persist
hal/          abstract buses (no board pins)
board/        board_t from owned IR / dummy
```

**HAL rule:** `hal/` speaks peripherals. `board/` supplies pins from IR.
`drivers/` never `#define PA4`.

## Runtime contract

```
loop_gyro @ gyro_hz
  → loop_filter / loop_pid / mixer→dshot @ gyro_hz / pid_process_denom
background: rx_poll, cli_poll, failsafe_tick
```

Cooperative, single-thread. No RTOS for MVP.

## Init order

1. `hal_clock_init(hse_mhz)` — dummy uses 0 until verified IR
2. `hal_time_init()`
3. `board_init()` — dummy or IR
4. `motor_safe_idle()` — motors safe **before** other bring-up
5. USB CDC + CLI
6. SPI / EXTI / TIM objects from `board_t` (no-op if invalid pins)
7. `scheduler_init` → `for(;;) scheduler_run()`

## Board IR

Pins come only from `/workspace/board-defs/` (see `boards/README.md`).
Until `verified`, firmware uses dummy F722 (`board: dummy`, all pins invalid).

## Deferred (not in skeleton feature code)

OSD · blackbox · GPS/baro/mag · bidir DShot · dyn notch · MSP/Configurator ·
LED/VTX · FreeRTOS · ANGLE/HORIZON.

## HAL pin packing

`hal_pin_t` is opaque. `HAL_PIN_PACK(port, num)` is MCU-generic (port 0=A).
Drivers never pack literals. Only `board/` / `ir_codegen.py` may emit pins,
and only from a Hardware-`verified` IR. Dummy board keeps every pin
`HAL_PIN_INVALID` so GPIO/SPI/UART/TIM/EXTI fail closed.

STM32F7 HAL units are CMSIS-optional (`-DBOBFLIGHT_HAVE_CMSIS` when
`third_party/` is audited). Without CMSIS they still implement the
interfaces and refuse invalid pins.
