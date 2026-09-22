/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime board pin map. Fields match owned IR schema keys.
 * Pins come ONLY from owned board IR — never invent T-Motor MCU pins.
 */
#ifndef BOBFLIGHT_BOARD_H
#define BOBFLIGHT_BOARD_H

#include <stdint.h>
#include <stdbool.h>
#include "hal/hal.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BOARD_MOTOR_MAX 4
#define BOARD_ID_MAX    48

typedef struct {
    hal_pin_t pin;
    uint8_t   timer;   /* TIM number; 0 = invalid */
    uint8_t   channel; /* 1..4; 0 = invalid */
} board_motor_ch_t;

typedef struct {
    char board_id[BOARD_ID_MAX];
    bool is_dummy;
    bool ir_verified;    /* true only after Hardware status: verified */
    bool ir_bf_derived; /* BF-derived IR exception; not bench-verified */

    /* mcu */
    char     mcu_family[24];
    uint32_t hse_mhz;

    /* gyro */
    char      gyro_chip[24];
    unsigned  gyro_spi_bus;
    hal_pin_t gyro_cs_pin;
    hal_pin_t gyro_sck_pin, gyro_miso_pin, gyro_mosi_pin;
    hal_pin_t gyro_exti_pin;
    char      gyro_align[16];

    /* Optional SD capability. No slot means SPI=0 and invalid pins. */
    unsigned sd_spi_bus;
    hal_pin_t sd_cs_pin,sd_sck_pin,sd_miso_pin,sd_mosi_pin,sd_detect_pin;

    /* motors */
    board_motor_ch_t motors[BOARD_MOTOR_MAX];
    unsigned         motor_count;

    /* uart.serial_rx */
    unsigned  rx_uart;       /* 1..N; 0 = invalid */
    hal_pin_t rx_pin;
    hal_pin_t tx_pin;
    char      rx_protocol[12]; /* e.g. CRSF */

    /* usb */
    bool usb_enable_cdc;
} board_t;

/** Global board instance filled by board_init / ir_load. */
const board_t *board_get(void);

/**
 * Init phases: load dummy or verified IR into board_t.
 * Until Hardware marks an IR verified, this is the dummy F722 board
 * (all pins HAL_PIN_INVALID; board_id "dummy").
 */
bool board_init(void);
bool board_select_rx_uart(unsigned uart);

/** IR loader hook — may hardcode dummy; YAML/codegen later. */
bool board_ir_load_dummy(board_t *out);

/** MMIO: verified IR, or bf-derived bring-up exception. Dummy always false. */
bool board_mmio_permitted(void);
/** Pins from generated IR (not dummy). */
bool board_pins_live(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_BOARD_H */
