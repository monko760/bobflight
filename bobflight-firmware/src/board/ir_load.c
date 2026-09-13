/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Load board_t from generated IR header. Pin *values* may be GPLv3-derived
 * facts (see pins_generated.h). This .c is Apache-2.0 and does not include
 * Betaflight config.h.
 */
#include "board/board.h"
#include "board/pins_generated.h"

#include <string.h>

static board_t g_board;
static bool target_mcu_ok=true;

const board_t *board_get(void)
{
    return &g_board;
}

bool board_ir_load_dummy(board_t *out)
{
    if (!out) {
        return false;
    }
    memset(out, 0, sizeof(*out));

    strncpy(out->board_id, BOARD_GENERATED_ID, BOARD_ID_MAX - 1);
    out->is_dummy = (BOARD_GENERATED_IS_DUMMY != 0);
    out->ir_verified = (BOARD_GENERATED_IR_VERIFIED != 0);
    out->ir_bf_derived = (BOARD_GENERATED_IR_BF_DERIVED != 0);

    strncpy(out->mcu_family, BOARD_GENERATED_MCU_FAMILY, sizeof(out->mcu_family) - 1);
    out->hse_mhz = BOARD_GENERATED_HSE_MHZ;
    /* Kakute F7 HDV: IR hse_mhz null — documented 8 MHz HSE until Hardware fills IR. */
    if (out->hse_mhz == 0u && strcmp(out->board_id, "kakute_f7_hdv") == 0) {
        out->hse_mhz = 8u;
    }

    strncpy(out->gyro_chip, BOARD_GENERATED_GYRO_CHIP, sizeof(out->gyro_chip) - 1);
    out->gyro_spi_bus = BOARD_GENERATED_GYRO_SPI;
    out->gyro_cs_pin = BOARD_GENERATED_GYRO_CS;
    out->gyro_sck_pin = BOARD_GENERATED_GYRO_SCK;
    out->gyro_miso_pin = BOARD_GENERATED_GYRO_MISO;
    out->gyro_mosi_pin = BOARD_GENERATED_GYRO_MOSI;
    out->gyro_exti_pin = BOARD_GENERATED_GYRO_EXTI;
    strncpy(out->gyro_align, BOARD_GENERATED_GYRO_ALIGN, sizeof(out->gyro_align) - 1);

    out->motor_count = BOARD_MOTOR_MAX;
    out->motors[0].pin = BOARD_GENERATED_MOTOR1_PIN;
    out->motors[0].timer = (uint8_t)BOARD_GENERATED_MOTOR1_TIM;
    out->motors[0].channel = (uint8_t)BOARD_GENERATED_MOTOR1_CH;
    out->motors[1].pin = BOARD_GENERATED_MOTOR2_PIN;
    out->motors[1].timer = (uint8_t)BOARD_GENERATED_MOTOR2_TIM;
    out->motors[1].channel = (uint8_t)BOARD_GENERATED_MOTOR2_CH;
    out->motors[2].pin = BOARD_GENERATED_MOTOR3_PIN;
    out->motors[2].timer = (uint8_t)BOARD_GENERATED_MOTOR3_TIM;
    out->motors[2].channel = (uint8_t)BOARD_GENERATED_MOTOR3_CH;
    out->motors[3].pin = BOARD_GENERATED_MOTOR4_PIN;
    out->motors[3].timer = (uint8_t)BOARD_GENERATED_MOTOR4_TIM;
    out->motors[3].channel = (uint8_t)BOARD_GENERATED_MOTOR4_CH;

    out->rx_uart = BOARD_GENERATED_RX_UART;
    out->rx_pin = BOARD_GENERATED_RX_PIN;
    out->tx_pin = BOARD_GENERATED_TX_PIN;
    strncpy(out->rx_protocol, BOARD_GENERATED_RX_PROTO, sizeof(out->rx_protocol) - 1);

    out->usb_enable_cdc = true;
    return true;
}

bool board_init(void)
{
    bool loaded=board_ir_load_dummy(&g_board);
#if defined(BOBFLIGHT_MCU) && defined(BOBFLIGHT_TARGET_TMOTORF7V2)
    /* RM0431 F72x/73x device family + ST F722 FLASHSIZE register.
     * Not proof of board identity; reject wrong family/capacity before peripherals. */
    target_mcu_ok=((*(volatile const uint32_t *)(uintptr_t)0xE0042000u & 0xFFFu)==0x452u);
    if(target_mcu_ok)target_mcu_ok=(*(volatile const uint16_t *)(uintptr_t)0x1FF07A22u==512u);
#endif
    return loaded && target_mcu_ok;
}

bool board_mmio_permitted(void)
{
    if (g_board.is_dummy || !target_mcu_ok) {
        return false;
    }
    return g_board.ir_verified || g_board.ir_bf_derived;
}

bool board_pins_live(void)
{
    return target_mcu_ok && !g_board.is_dummy && (g_board.ir_verified || g_board.ir_bf_derived);
}

bool board_select_rx_uart(unsigned uart){
    if(strcmp(g_board.board_id,"kakute_f7_hdv"))return false;
    hal_pin_t rx,tx;
    switch(uart){
    case 1:rx=HAL_PIN_PACK(0,10);tx=HAL_PIN_PACK(0,9);break;
    case 2:rx=HAL_PIN_PACK(3,6);tx=HAL_PIN_PACK(3,5);break;
    case 3:rx=HAL_PIN_PACK(1,11);tx=HAL_PIN_PACK(1,10);break;
    case 4:rx=HAL_PIN_PACK(0,1);tx=HAL_PIN_PACK(0,0);break;
    case 6:rx=HAL_PIN_PACK(2,7);tx=HAL_PIN_PACK(2,6);break;
    case 7:rx=HAL_PIN_PACK(4,7);tx=HAL_PIN_INVALID;break;
    default:return false;
    }
    g_board.rx_uart=uart;g_board.rx_pin=rx;g_board.tx_pin=tx;return true;
}
