# Matek F722-PX IR Provenance

## Source Reference
- Board target: Matek F722-PX (`matek_f722_px`)
- MCU: STM32F722RE 512KiB flash
- Manufacturer details: https://www.mateksys.com/?portfolio=f722-px
- Pinned Betaflight factual configuration reference:
  https://raw.githubusercontent.com/betaflight/config/e1d87e7ecf6717bd3806a08400aeb892cd1d1fc3/configs/MTKS/MATEKF722HD/config.h

## Hardware Facts
- Gyro: MPU6000 on SPI1
  - SPI1 SCK: PA5
  - SPI1 MISO: PA6
  - SPI1 MOSI: PA7
  - CS: PB2
  - EXTI / DRDY: PC4
  - Alignment reference: CW180_DEG_FLIP (including the sensor Z-axis flip)
- Onboard Flash: 32MB onboard SPI flash per manufacturer (exact part/capacity still to be probed) on SPI2 (CS PB12). No SD card slot.
- OSD: Frsky Pixel OSD on UART6 (excluded from selectable RX UARTs).
- Status LED: PA14 (LED0)
- Voltage ADC: PC2 (VBAT)
- Current ADC: PC1 (CURR)

## UART Routing
- UART1: TX PA9, RX PA10
- UART2: TX PA2, RX PA3 (default CRSF receiver)
- UART3: TX PC10, RX PC11
- UART4: TX PA0, RX PA1
- UART5: Unsupported (missing driver)
- UART6: Excluded (onboard OSD)

## Target Scope
- Target profile: `sensor-only` / sensor bring-up image.
- Motor output: Disabled (`motor_output: false`).
- SD logging: Disabled (`sd_logging: false`).
- USB CDC: Enabled (`usb_cdc: true`).
