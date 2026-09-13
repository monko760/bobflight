/* SPDX-License-Identifier: Apache-2.0
 * STM32F745 SPI4 / STM32F722 SPI1, RM0385/RM0431: 8-bit, software NSS, bounded full-duplex transfer. */
#include "hal_f7_priv.h"
#include "board/board.h"
#include "gyro_spi_map.h"
typedef struct { volatile uint32_t CR1, CR2, SR, DR; } spi_regs_t;
struct hal_spi_bus { spi_regs_t *r; bool open; };
static hal_spi_bus_t bus;
hal_spi_bus_t *hal_spi_open_cfg(const hal_spi_cfg_t *cfg) {
    const board_t *b=board_get();
    uintptr_t base; uint32_t enable;
    if (!board_mmio_permitted() || !cfg || !cfg->hz || cfg->bits!=8 || cfg->cpol>1 || cfg->cpha>1 ||
        !gyro_spi_map(b,cfg->bus_index,&base,&enable)) return 0;
    hal_gpio_cfg_t af={HAL_GPIO_AF,HAL_GPIO_PULL_NONE,HAL_GPIO_SPEED_VERYHIGH,5};
    if (!hal_gpio_configure(b->gyro_sck_pin,&af) || !hal_gpio_configure(b->gyro_miso_pin,&af) || !hal_gpio_configure(b->gyro_mosi_pin,&af)) return 0;
    hal_gpio_init(b->gyro_cs_pin,HAL_GPIO_OUT); hal_gpio_write(b->gyro_cs_pin,true);
    HAL_F7_RCC->APB2ENR |= enable; (void)HAL_F7_RCC->APB2ENR;
    bus.r=(spi_regs_t*)base; bus.r->CR1=0;
    unsigned br=0; uint32_t clock=hal_f7_pclk(true)/2;
    while (clock>cfg->hz && br<7) {br++; clock/=2;}
    bus.r->CR2=(7u<<8)|(1u<<12); /* DS=8, RXNE at 8 bits */
    bus.r->CR1=(1u<<2)|(br<<3)|(1u<<8)|(1u<<9)|(cfg->cpol?2u:0u)|(cfg->cpha?1u:0u)|(1u<<6);
    bus.open=true; return &bus;
}
hal_spi_bus_t *hal_spi_open(unsigned index) {
    hal_spi_cfg_t cfg={index,1000000u,1,1,8}; return hal_spi_open_cfg(&cfg);
}
static bool wait_flag(spi_regs_t *r,uint32_t mask,bool set) {
    unsigned n=10000;
    while (((r->SR & mask)!=0)!=set) if (!--n) return false;
    return true;
}
bool hal_spi_transfer(hal_spi_bus_t *b,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t len) {
    if (!b || !b->open || !hal_pin_valid(cs) || !len) return false;
    bool ok=false; hal_gpio_write(cs,false);
    for (size_t i=0;i<len;i++) {
        if (!wait_flag(b->r,2,true)) goto done;
        *(volatile uint8_t*)&b->r->DR=tx?tx[i]:0;
        if (!wait_flag(b->r,1,true)) goto done;
        uint8_t v=*(volatile uint8_t*)&b->r->DR; if(rx) rx[i]=v;
    }
    ok=wait_flag(b->r,1u<<7,false);
done:
    hal_gpio_write(cs,true); return ok;
}
