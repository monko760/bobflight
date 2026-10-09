/* SPDX-License-Identifier: Apache-2.0
 * Nonblocking STM32F722 I2C1 register read/write bus driver.
 * Peripheral facts: ST RM0431. Pins come from owned board IR.
 */
#include "hal/i2c_reg.h"
#include "board/board.h"
#include "hal_f7_priv.h"
#include <string.h>

typedef struct {
    volatile uint32_t CR1;       /* 0x00 */
    volatile uint32_t CR2;       /* 0x04 */
    volatile uint32_t OAR1;      /* 0x08 */
    volatile uint32_t OAR2;      /* 0x0C */
    volatile uint32_t TIMINGR;   /* 0x10 */
    volatile uint32_t TIMEOUTR;  /* 0x14 */
    volatile uint32_t ISR;       /* 0x18 */
    volatile uint32_t ICR;       /* 0x1C */
    volatile uint32_t PECR;      /* 0x20 */
    volatile uint32_t RXDR;      /* 0x24 */
    volatile uint32_t TXDR;      /* 0x28 */
} i2c_regs_t;

_Static_assert(offsetof(i2c_regs_t, CR1) == 0x00, "CR1 offset");
_Static_assert(offsetof(i2c_regs_t, CR2) == 0x04, "CR2 offset");
_Static_assert(offsetof(i2c_regs_t, OAR1) == 0x08, "OAR1 offset");
_Static_assert(offsetof(i2c_regs_t, OAR2) == 0x0C, "OAR2 offset");
_Static_assert(offsetof(i2c_regs_t, TIMINGR) == 0x10, "TIMINGR offset");
_Static_assert(offsetof(i2c_regs_t, TIMEOUTR) == 0x14, "TIMEOUTR offset");
_Static_assert(offsetof(i2c_regs_t, ISR) == 0x18, "ISR offset");
_Static_assert(offsetof(i2c_regs_t, ICR) == 0x1C, "ICR offset");
_Static_assert(offsetof(i2c_regs_t, PECR) == 0x20, "PECR offset");
_Static_assert(offsetof(i2c_regs_t, RXDR) == 0x24, "RXDR offset");
_Static_assert(offsetof(i2c_regs_t, TXDR) == 0x28, "TXDR offset");

#define I2C_ISR_TXIS     (1u << 1)
#define I2C_ISR_RXNE     (1u << 2)
#define I2C_ISR_NACKF    (1u << 4)
#define I2C_ISR_STOPF    (1u << 5)
#define I2C_ISR_TC       (1u << 6)
#define I2C_ISR_BERR     (1u << 8)
#define I2C_ISR_ARLO     (1u << 9)
#define I2C_ISR_OVR      (1u << 10)
#define I2C_ISR_TIMEOUT  (1u << 12)
#define I2C_ISR_BUSY     (1u << 15)

#define I2C_ERR_FLAGS (I2C_ISR_NACKF | I2C_ISR_BERR | I2C_ISR_ARLO | I2C_ISR_OVR | I2C_ISR_TIMEOUT)
#define I2C_ICR_ALL   (0x3F38u) /* ADDRCF, NACKCF, STOPCF, BERRCF, ARLOCF, OVRCF, TIMEOUTCF */

#ifdef BOBFLIGHT_I2C_HW_TEST
static i2c_regs_t test_i2c1_regs;
static uint32_t test_apb1enr;
static uint32_t test_dckcfgr2;
static hal_f7_gpio_regs_t test_gpiob_regs;

#define I2C_PCLK 42000000u
#define I2C1_REGS (&test_i2c1_regs)
#define RCC_APB1ENR_PTR (&test_apb1enr)
#define RCC_DCKCFGR2_PTR (&test_dckcfgr2)
#define GPIOB_REGS (&test_gpiob_regs)
#else
#define I2C_PCLK hal_f7_pclk(false)
#define I2C1_REGS ((i2c_regs_t *)(uintptr_t)0x40005400u)
#define RCC_APB1ENR_PTR (&HAL_F7_RCC->APB1ENR)
#define RCC_DCKCFGR2_PTR (&HAL_F7_RCC->DCKCFGR2)
#define GPIOB_REGS hal_f7_gpio(1)
#endif

typedef enum {
    I2C_REG_STATE_IDLE = 0,
    I2C_REG_STATE_ERROR,
    I2C_REG_STATE_READ_TX_REG,
    I2C_REG_STATE_READ_WAIT_TC,
    I2C_REG_STATE_READ_RX_DATA,
    I2C_REG_STATE_READ_WAIT_STOP,
    I2C_REG_STATE_WRITE_TX_REG,
    I2C_REG_STATE_WRITE_TX_DATA,
    I2C_REG_STATE_WRITE_WAIT_STOP
} i2c_reg_state_t;

static struct {
    bool bound;
    i2c_reg_state_t state;
    uint8_t addr;
    uint8_t reg;
    uint8_t *data;
    uint8_t len;
    uint8_t byte_idx;
    bool read;
    uint64_t start_time;
} g_hw;

static void i2c_reg_cleanup_error(void)
{
    I2C1_REGS->ICR = I2C_ICR_ALL;
    I2C1_REGS->CR1 &= ~1u;
    I2C1_REGS->CR1 |= 1u;
    g_hw.state = I2C_REG_STATE_ERROR;
}

bool i2c_reg_bind(unsigned bus, hal_pin_t scl, hal_pin_t sda)
{
    if (g_hw.bound) {
        return false;
    }
    const board_t *b = board_get();
    if (!b || !board_mmio_permitted() || !hal_time_high_resolution()) {
        return false;
    }
    if (strcmp(b->mcu_family, "STM32F722") != 0) {
        return false;
    }
    if (bus != 1u) {
        return false;
    }
    /* Exact known routing: PB8 SCL, PB9 SDA */
    if (scl != HAL_PIN_PACK(1u, 8u) || sda != HAL_PIN_PACK(1u, 9u)) {
        return false;
    }

    const uint32_t pclk=I2C_PCLK;
    if(pclk<21000000u||pclk>54000000u)return false;
    hal_gpio_cfg_t cfg;
    cfg.mode = HAL_GPIO_AF;
    cfg.pull = HAL_GPIO_PULL_NONE;
    cfg.speed = HAL_GPIO_SPEED_MED;
    cfg.af = 4;



    /* RCC APB1 bit 21 (I2C1EN) */
    *RCC_APB1ENR_PTR |= (1u << 21);
    (void)*RCC_APB1ENR_PTR;
    I2C1_REGS->CR1=0; /* peripheral clock must be on before disabling PE */

    /* Kernel clock PCLK1 via DCKCFGR2 bits 16..17 = 00 */
    *RCC_DCKCFGR2_PTR &= ~(3u << 16);

    if (!hal_gpio_configure(scl, &cfg) || !hal_gpio_configure(sda, &cfg)) {
        return false;
    }

    hal_f7_gpio_regs_t *gpiob = GPIOB_REGS;
    if (gpiob) {
        gpiob->OTYPER |= (1u << 8) | (1u << 9);
    }

    /* Fixed conservative TIMINGR for PCLK1 21..54MHz <=100kHz standard mode */
    I2C1_REGS->TIMINGR = (15u << 28) | (4u << 20) | (1u << 16) | (31u << 8) | 31u;
    I2C1_REGS->CR1 |= 1u; /* Enable PE */

    g_hw.bound = true;
    g_hw.state = I2C_REG_STATE_IDLE;
    return true;
}

bool i2c_reg_begin(uint8_t addr, uint8_t reg, uint8_t *data, uint8_t len, bool read, uint64_t now)
{
    if (!g_hw.bound || addr<8u || addr>0x77u || (!read&&len==255u)) {
        return false;
    }
    if (g_hw.state != I2C_REG_STATE_IDLE && g_hw.state != I2C_REG_STATE_ERROR) {
        return false;
    }
    /* Guard BUSY at begin: refuse without stealing bus */
    if (I2C1_REGS->ISR & I2C_ISR_BUSY) {
        return false;
    }
    if (read) {
        if (!data || len == 0) {
            return false;
        }
    } else {
        if (len > 0 && !data) {
            return false;
        }
    }

    g_hw.addr = addr;
    g_hw.reg = reg;
    g_hw.data = data;
    g_hw.len = len;
    g_hw.read = read;
    g_hw.start_time = now;
    g_hw.byte_idx = 0;

    I2C1_REGS->ICR = I2C_ICR_ALL;

    if (read) {
        /* Phase 1: Write register address (NBYTES=1, AUTOEND=0, RD_WRN=0, START=1) */
        uint32_t cr2 = ((uint32_t)(addr & 0x7F) << 1)
                     | (1u << 16)
                     | (1u << 13);
        I2C1_REGS->CR2 = cr2;
        g_hw.state = I2C_REG_STATE_READ_TX_REG;
    } else {
        /* Write transaction: NBYTES=len+1, AUTOEND=1, RD_WRN=0, START=1 */
        uint32_t nbytes = (uint32_t)len + 1u;
        uint32_t cr2 = ((uint32_t)(addr & 0x7F) << 1)
                     | ((nbytes & 0xFFu) << 16)
                     | (1u << 25)
                     | (1u << 13);
        I2C1_REGS->CR2 = cr2;
        g_hw.state = I2C_REG_STATE_WRITE_TX_REG;
    }

    return true;
}

int i2c_reg_poll(uint64_t now)
{
    if (!g_hw.bound) {
        return -1;
    }
    if (g_hw.state == I2C_REG_STATE_IDLE) {
        return 1;
    }
    if (g_hw.state == I2C_REG_STATE_ERROR) {
        return -1;
    }

    if (now < g_hw.start_time || (now - g_hw.start_time) >= 20000u) {
        i2c_reg_cleanup_error();
        return -1;
    }

    uint32_t isr = I2C1_REGS->ISR;
    if (isr & I2C_ERR_FLAGS) {
        i2c_reg_cleanup_error();
        return -1;
    }

    switch (g_hw.state) {
    case I2C_REG_STATE_READ_TX_REG:
        if (isr & I2C_ISR_TXIS) {
            I2C1_REGS->TXDR = g_hw.reg;
            g_hw.state = I2C_REG_STATE_READ_WAIT_TC;
        }
        return 0;

    case I2C_REG_STATE_READ_WAIT_TC:
        if (isr & I2C_ISR_TC) {
            /* Repeated START for read phase (NBYTES=len, AUTOEND=1, RD_WRN=1, START=1) */
            uint32_t cr2 = ((uint32_t)(g_hw.addr & 0x7F) << 1)
                         | (1u << 10)
                         | (((uint32_t)g_hw.len & 0xFFu) << 16)
                         | (1u << 25)
                         | (1u << 13);
            I2C1_REGS->CR2 = cr2;
            g_hw.byte_idx = 0;
            g_hw.state = I2C_REG_STATE_READ_RX_DATA;
        }
        return 0;

    case I2C_REG_STATE_READ_RX_DATA:
        if (isr & I2C_ISR_RXNE) {
            g_hw.data[g_hw.byte_idx++] = (uint8_t)(I2C1_REGS->RXDR & 0xFFu);
            if (g_hw.byte_idx >= g_hw.len) {
                g_hw.state = I2C_REG_STATE_READ_WAIT_STOP;
            }
        }
        return 0;

    case I2C_REG_STATE_READ_WAIT_STOP:
        if (isr & I2C_ISR_STOPF) {
            I2C1_REGS->ICR = (1u << 5); /* Clear STOPCF */
            g_hw.state = I2C_REG_STATE_IDLE;
            return 1;
        }
        return 0;

    case I2C_REG_STATE_WRITE_TX_REG:
        if (isr & I2C_ISR_TXIS) {
            I2C1_REGS->TXDR = g_hw.reg;
            if (g_hw.len > 0) {
                g_hw.byte_idx = 0;
                g_hw.state = I2C_REG_STATE_WRITE_TX_DATA;
            } else {
                g_hw.state = I2C_REG_STATE_WRITE_WAIT_STOP;
            }
        }
        return 0;

    case I2C_REG_STATE_WRITE_TX_DATA:
        if (isr & I2C_ISR_TXIS) {
            I2C1_REGS->TXDR = g_hw.data[g_hw.byte_idx++];
            if (g_hw.byte_idx >= g_hw.len) {
                g_hw.state = I2C_REG_STATE_WRITE_WAIT_STOP;
            }
        }
        return 0;

    case I2C_REG_STATE_WRITE_WAIT_STOP:
        if (isr & I2C_ISR_STOPF) {
            I2C1_REGS->ICR = (1u << 5); /* Clear STOPCF */
            g_hw.state = I2C_REG_STATE_IDLE;
            return 1;
        }
        return 0;

    default:
        break;
    }

    return 0;
}

void i2c_reg_cancel(void)
{
    if (!g_hw.bound) {
        return;
    }
    if (g_hw.state != I2C_REG_STATE_IDLE && g_hw.state != I2C_REG_STATE_ERROR) {
        i2c_reg_cleanup_error();
    }
}
