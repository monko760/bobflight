# F405 shared-application integration boundary

This is an implementation dependency map, not a supported-image declaration.
F405 component tests and the working USB-only diagnostic do not yet make the
normal application a working F405 target.

## Startup order to preserve

The shared `app_init()` loads board metadata, initializes clocks/time, starts USB,
then initializes the shared gyro and receiver drivers. Existing F405 clock,
timebase, USB preparation and SPI initialization require reset-time Thread mode
with interrupts masked. SPI transfers, by contrast, must allow normal interrupts.

Therefore prepare the sensor GPIO and SPI transport, and bind the gyro SPI HAL,
before unmasking interrupts. Do not move masked SPI initialization into the later
`hal_spi_open()` call inside `gyro_init()`. That call should retrieve the prepared
binding. Bring up USB with its owned timebase, then unmask interrupts and let the
shared driver perform its sensor reset/configuration sequence. Keep the same
shared `gyro.c` and calibration/orientation implementation.

`SystemCoreClock` must reflect successful clock startup before the shared early
settling code uses it. Failed time reads must not masquerade as zero timestamps
or successful delays. Gyro initialization includes 100 ms, 100 ms and 20 ms
sensor delays; the HAL adapter must bound waits and handle timebase failure,
while normal USB service must not later be blocked by sensor polling.

## Explicit backend work

- Select F405xG startup, linker layout and TinyUSB configuration through the
  normal MCU backend mechanism; register an owned MLTEMPF4 board definition.
- Supply the common clock/time, GPIO and boot-stage interfaces. Retain the
  existing DWT/SysTick ownership contract and clock-failure reporting.
- Provide USB CDC read/write/service/connect/disconnect and IRQ integration
  using the existing validated USB components, not the F7 register wrapper.
- Connect the GPIO preparation, SPI component and `gyro_spi_bridge` before
  shared sensor initialization. Initial acquisition remains the 1 kHz path.
- Supply truthful unsupported returns for peripherals not implemented in the
  first sensor increment. Never advertise flash Save, motor output, ADC, SD,
  receiver or software bootloader success from a stub.
- Then replace those unsupported paths with the UART, persistence, bootloader,
  motor/DMA, ADC and storage implementations described in the parity plan.

This temporary sensor integration is not the finished single-image workflow.
Persistent aircraft configuration through `diff all` and `save` remains a
required feature, not a permanently optional profile. No arming policy changes
or flight qualification follow from linking the shared application.

## Resource and deployment checks

DMA buffers must remain in DMA-accessible SRAM, not F405 CCM. Audit actual linked
RAM use, including existing logger buffers, rather than assuming F7 headroom.
Keep the reserved F405 settings sectors out of the application/erase ranges.
The flasher must validate a sensor-capable image as such; do not reuse the
USB-only identity marker for firmware that accesses sensor pins. No component
fixture is a firmware installation candidate.

Physical acceptance for the first sensor image: cold boot, USB CLI reconnect,
MPU6000 identity/configuration, correct stationary and tilt vectors, monotonically
fresh sample sequence, real timing/jitter under USB load, and bounded handling
of a sensor fault. No receiver, ESC or external supply is needed for that first
bare-board milestone.
