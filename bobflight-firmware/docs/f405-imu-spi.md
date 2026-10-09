# F405 MPU6000 transport increment

Goal: reuse the existing shared `drivers/gyro.c` for the Motolab Tempest F4,
then expose sensor telemetry through the normal shared firmware. This increment
adds the isolated F405 SPI transport and its shared-HAL bridge. It does **not**
change the working USB-only image or register an operational main F405 target.

## Routing evidence, not physical qualification

The matching upstream hardware definition is pinned at
[Betaflight config e0273b9564854e0ee1fbadd8200875b30bd35650](https://github.com/betaflight/config/blob/e0273b9564854e0ee1fbadd8200875b30bd35650/configs/MOLA/MLTEMPF4/config.h).
Only factual wiring information is recorded here. No upstream implementation or
configuration file is copied into BobFlight.

| Resource | Published reference |
| --- | --- |
| MCU / HSE | STM32F405 / 8 MHz |
| IMU | MPU6000 |
| SPI / SCK / MISO / MOSI | SPI1 / PA5 / PA6 / PA7 |
| Active-low chip select | PA4 |
| Data-ready line | PC5 |
| Sensor-to-board rotation | CW180_DEG |

The user reports an F405/MPU6000 board and working BobFlight USB diagnostic.
The precise PCB revision, measured oscillator frequency, physical traces and
orientation still need bench confirmation. These facts do not promote the board
to hardware-qualified. USB uses PA11/12; PA9 remains untouched. Other onboard
peripherals are out of scope. Later UART routing must reject resource conflicts,
including the published SPI3 MOSI / UART5 TX overlap at PC12.

## Integration boundary

The shared driver already configures MPU6000 registers, checks identity and
configuration readback, scales gyro/accel values, applies orientation, tracks
fresh samples and performs calibration/health checks. Do not fork that logic
into an F405-specific sensor implementation.

`gyro_spi_bridge.c` binds an initialized, exclusively owned SPI1 transport with
a caller-owned chip-select callback to the existing `hal_spi_*` contract. The
caller must first initialize GPIO/AF, keep CS inactive and initialize clocks and
SPI. Board metadata must agree on the bound bus and CS. Transfers are limited to
17 bytes, matching the existing gyro driver's maximum transaction. MPU register
access remains at or below 1 MHz, including when a higher rate is requested.
At nominal 84 MHz APB2 the first supported setting is /128, or 656250 Hz. This
is a configured nominal rate, not a measured hardware frequency or loop budget.

No fast loop-rate eligibility, arming policy, motor capability or flight-ready
status is added. GPIO/MMIO bring-up, board registration, sensor CLI integration,
nonvolatile settings, receiver/UART backends and safe software bootloader entry
remain later integration work. Do not flash a component test executable.

## Verification and remaining work

Run `python3 tests/test_f405_spi_component.py` from `bobflight-firmware` with ARM
GCC, pyelftools and Unicorn installed via the existing F4 component requirements.
It cross-compiles Cortex-M4 code and executes the real reset entry, SPI component,
HAL bridge and unchanged shared gyro driver (`BOBFLIGHT_HOST=0`) against a model.
There is no host-mode gyro injection. Tests cover identity/configuration failures,
CW180 gyro/accel golden vectors, sample sequence/freshness, invalid call guards,
clock/control-write rejection, and bounded TXE/RXNE/BSY/OVR/MODF/timebase failures.
A frozen modeled clock still exhausts the transaction-wide poll budget. Runtime
calls preserve unmasked interrupts, unlike the reset-time initialization call.
The failed-transfer path requests SPE disable and CS release, then latches the
error. It does not automatically reset/retry hardware or publish a valid sample.

The sensor and clock responses are modeled. GPIO electrical behavior, real sample
intervals, USB under sensor load and physical mounting have not been measured.
This is not a firmware installation candidate. Next, bind the referenced GPIO
resources and the established timebase into a USB sensor bring-up build with
explicit sensor-image validation, then check WHO_AM_I, configured registers,
stationary/tilt telemetry, sample age and timing on the bare board. Only after
that milestone should receiver/UART routing and nonvolatile configuration be
connected through the existing shared interfaces. No arming policy or main
firmware support declaration is changed by these components.
