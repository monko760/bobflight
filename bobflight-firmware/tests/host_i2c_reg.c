/* SPDX-License-Identifier: Apache-2.0
 * Host register model tests for STM32F722 I2C1 nonblocking register bus.
 */
#define BOBFLIGHT_I2C_HW_TEST 1
#include "../src/hal/stm32f7/i2c_reg.c"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static board_t board;
static bool allowed = true;
static bool highres = true;
static bool gpio_ok = true;
static unsigned configs = 0;

const board_t *board_get(void)
{
    return &board;
}

bool board_mmio_permitted(void)
{
    return allowed && !board.is_dummy;
}

bool hal_time_high_resolution(void)
{
    return highres;
}

bool hal_gpio_configure(hal_pin_t p, const hal_gpio_cfg_t *cfg)
{
    assert(p == HAL_PIN_PACK(1, 8) || p == HAL_PIN_PACK(1, 9));
    assert(cfg->mode == HAL_GPIO_AF && cfg->af == 4);
    configs++;
    return gpio_ok;
}

int main(void)
{
    memset(&board, 0, sizeof(board));
    strcpy(board.mcu_family, "STM32F722");
    board.is_dummy = false;

    hal_pin_t scl_pin = HAL_PIN_PACK(1, 8);
    hal_pin_t sda_pin = HAL_PIN_PACK(1, 9);

    /* 1. Validation / Routing tests */
    allowed = false;
    assert(!i2c_reg_bind(1, scl_pin, sda_pin));
    allowed = true;

    highres = false;
    assert(!i2c_reg_bind(1, scl_pin, sda_pin));
    highres = true;

    strcpy(board.mcu_family, "STM32F405");
    assert(!i2c_reg_bind(1, scl_pin, sda_pin));
    strcpy(board.mcu_family, "STM32F722");

    assert(!i2c_reg_bind(2, scl_pin, sda_pin)); /* wrong bus */
    assert(!i2c_reg_bind(1, HAL_PIN_PACK(1, 7), sda_pin)); /* wrong scl pin */
    assert(!i2c_reg_bind(1, scl_pin, HAL_PIN_PACK(1, 10))); /* wrong sda pin */

    gpio_ok = false;
    assert(!i2c_reg_bind(1, scl_pin, sda_pin));
    gpio_ok = true;

    /* 2. Successful Bind */
    assert(i2c_reg_bind(1, scl_pin, sda_pin));
    assert(test_apb1enr & (1u << 21)); /* APB1 bit 21 enabled */
    assert((test_dckcfgr2 & (3u << 16)) == 0); /* DCKCFGR2 bits 16..17 cleared */
    assert((test_gpiob_regs.OTYPER & ((1u << 8) | (1u << 9))) == ((1u << 8) | (1u << 9))); /* Open drain set */
    assert(test_i2c1_regs.TIMINGR == 0xF0411F1Fu);
    assert(test_i2c1_regs.CR1 & 1u); /* PE enabled */

    /* Re-bind attempt should fail */
    assert(!i2c_reg_bind(1, scl_pin, sda_pin));

    /* 3. Guard BUSY at begin */
    test_i2c1_regs.ISR = (1u << 15); /* BUSY set */
    uint8_t rx_buf[4] = {0};
    assert(!i2c_reg_begin(0x76, 0xF7, rx_buf, 3, true, 100));
    test_i2c1_regs.ISR = 0; /* Clear BUSY */

    /* 4. Combined Read Test with step-by-step yield */
    assert(i2c_reg_begin(0x76, 0xF7, rx_buf, 3, true, 1000));
    /* CR2 Phase 1: SADD = 0xEC, NBYTES = 1, START = 1, AUTOEND = 0, RD_WRN = 0 */
    assert((test_i2c1_regs.CR2 & 0xFEu) == (0x76u << 1));
    assert(((test_i2c1_regs.CR2 >> 16) & 0xFFu) == 1u);
    assert(test_i2c1_regs.CR2 & (1u << 13)); /* START */
    assert(!(test_i2c1_regs.CR2 & (1u << 25))); /* AUTOEND = 0 */
    assert(!(test_i2c1_regs.CR2 & (1u << 10))); /* RD_WRN = 0 */

    /* Poll 1: TXIS not set yet -> pending */
    test_i2c1_regs.ISR = 0;
    assert(i2c_reg_poll(1000) == 0);

    /* Poll 2: TXIS set -> writes reg address to TXDR, pending */
    test_i2c1_regs.ISR = (1u << 1); /* TXIS */
    assert(i2c_reg_poll(1001) == 0);
    assert((test_i2c1_regs.TXDR & 0xFFu) == 0xF7u);

    /* Poll 3: Waiting TC, TC not set -> pending */
    test_i2c1_regs.ISR = 0;
    assert(i2c_reg_poll(1002) == 0);

    /* Poll 4: TC set -> repeated START read issued, pending */
    test_i2c1_regs.ISR = (1u << 6); /* TC */
    assert(i2c_reg_poll(1003) == 0);
    /* Check CR2 Phase 2: SADD = 0xEC, NBYTES = 3, START = 1, AUTOEND = 1, RD_WRN = 1 */
    assert((test_i2c1_regs.CR2 & 0xFEu) == (0x76u << 1));
    assert(((test_i2c1_regs.CR2 >> 16) & 0xFFu) == 3u);
    assert(test_i2c1_regs.CR2 & (1u << 13)); /* START */
    assert(test_i2c1_regs.CR2 & (1u << 25)); /* AUTOEND = 1 */
    assert(test_i2c1_regs.CR2 & (1u << 10)); /* RD_WRN = 1 */

    /* Poll 5: RXNE byte 0 */
    test_i2c1_regs.RXDR = 0x12u;
    test_i2c1_regs.ISR = (1u << 2); /* RXNE */
    assert(i2c_reg_poll(1004) == 0);
    assert(rx_buf[0] == 0x12u);

    /* Poll 6: RXNE byte 1 */
    test_i2c1_regs.RXDR = 0x34u;
    test_i2c1_regs.ISR = (1u << 2); /* RXNE */
    assert(i2c_reg_poll(1005) == 0);
    assert(rx_buf[1] == 0x34u);

    /* Poll 7: RXNE byte 2 */
    test_i2c1_regs.RXDR = 0x56u;
    test_i2c1_regs.ISR = (1u << 2); /* RXNE */
    assert(i2c_reg_poll(1006) == 0);
    assert(rx_buf[2] == 0x56u);

    /* Poll 8: STOPF set -> completion */
    test_i2c1_regs.ICR = 0;
    test_i2c1_regs.ISR = (1u << 5); /* STOPF */
    assert(i2c_reg_poll(1007) == 1); /* Done! */
    assert(test_i2c1_regs.ICR & (1u << 5)); /* STOPCF cleared */

    /* Poll when idle -> returns 1 */
    assert(i2c_reg_poll(1008) == 1);

    /* 5. Write Test with step-by-step yield */
    uint8_t tx_buf[2] = { 0x27, 0x00 };
    assert(i2c_reg_begin(0x76, 0xF4, tx_buf, 2, false, 2000));
    /* CR2: SADD = 0xEC, NBYTES = 3, AUTOEND = 1, START = 1, RD_WRN = 0 */
    assert((test_i2c1_regs.CR2 & 0xFEu) == (0x76u << 1));
    assert(((test_i2c1_regs.CR2 >> 16) & 0xFFu) == 3u);
    assert(test_i2c1_regs.CR2 & (1u << 25)); /* AUTOEND */
    assert(!(test_i2c1_regs.CR2 & (1u << 10))); /* RD_WRN = 0 */

    /* Poll 1: TXIS -> reg byte */
    test_i2c1_regs.ISR = (1u << 1); /* TXIS */
    assert(i2c_reg_poll(2001) == 0);
    assert((test_i2c1_regs.TXDR & 0xFFu) == 0xF4u);

    /* Poll 2: TXIS -> tx_buf[0] */
    test_i2c1_regs.ISR = (1u << 1); /* TXIS */
    assert(i2c_reg_poll(2002) == 0);
    assert((test_i2c1_regs.TXDR & 0xFFu) == 0x27u);

    /* Poll 3: TXIS -> tx_buf[1] */
    test_i2c1_regs.ISR = (1u << 1); /* TXIS */
    assert(i2c_reg_poll(2003) == 0);
    assert((test_i2c1_regs.TXDR & 0xFFu) == 0x00u);

    /* Poll 4: STOPF -> completion */
    test_i2c1_regs.ICR = 0;
    test_i2c1_regs.ISR = (1u << 5); /* STOPF */
    assert(i2c_reg_poll(2004) == 1);
    assert(test_i2c1_regs.ICR & (1u << 5));

    /* 6. NACK Error Handling */
    assert(i2c_reg_begin(0x76, 0xF7, rx_buf, 1, true, 3000));
    test_i2c1_regs.ICR = 0;
    test_i2c1_regs.ISR = (1u << 4); /* NACKF */
    assert(i2c_reg_poll(3001) == -1); /* Error */
    assert(test_i2c1_regs.ICR & (1u << 4)); /* NACKCF cleared */

    /* 7. Timeout Error Handling (20ms = 20000us) */
    assert(i2c_reg_begin(0x76, 0xF7, rx_buf, 1, true, 4000));
    assert(i2c_reg_poll(4000 + 20000) == -1); /* Timeout error */

    /* 8. Cancellation */
    assert(i2c_reg_begin(0x76, 0xF7, rx_buf, 1, true, 5000));
    test_i2c1_regs.ISR = 0;
    assert(i2c_reg_poll(5001) == 0); /* pending */
    i2c_reg_cancel();
    assert(i2c_reg_poll(5002) == -1); /* cancelled/error */

    /* Cancellation on IDLE/ERROR should be safe and non-interfering */
    i2c_reg_cancel();

    puts("PASS F722 I2C1 register model: AF4 PB8/PB9 opendrain, APB1 bit21, TIMINGR, combined read, write, NACK, timeout, busy, yields");
    return 0;
}
