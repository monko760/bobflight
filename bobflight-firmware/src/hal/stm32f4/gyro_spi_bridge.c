/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "gyro_spi_bridge.h"
#include "board/board.h"
struct hal_spi_bus { bf_f405_spi_bus_t *transport; hal_pin_t cs; bool open; };
static struct hal_spi_bus s_bus;
bool bf_f405_gyro_spi_bind(bf_f405_spi_bus_t *transport, hal_pin_t cs)
{
    if(s_bus.transport || !transport || !transport->cs_fn || !hal_pin_valid(cs) ||
       !bf_f405_spi_is_ready(transport)) return false;
    s_bus.transport=transport; s_bus.cs=cs; s_bus.open=false;
    return true;
}
void bf_f405_gyro_spi_unbind(void) { s_bus=(struct hal_spi_bus){0}; }
static bool binding_matches(void)
{
    const board_t *b=board_get();
    return s_bus.transport && b && board_mmio_permitted() &&
           b->gyro_spi_bus==1u && b->gyro_cs_pin==s_bus.cs &&
           bf_f405_spi_is_ready(s_bus.transport);
}
static uint32_t rate(uint32_t requested)
{
    /* Never exceed the MPU6000 general register limit even for a fast request.
     * At the validated 84 MHz APB2: /128 = 656250 Hz, /256 = 328125 Hz. */
    unsigned br=requested>=656250u ? 6u : 7u;
    uint32_t hz=84000000u/(2u<<br);
    if(!requested || hz>requested) return 0;
    if(s_bus.transport->prescaler!=(bf_f405_spi_prescaler_t)br &&
       bf_f405_spi_set_prescaler(s_bus.transport,(bf_f405_spi_prescaler_t)br)!=BF_F405_SPI_OK) return 0;
    return hz;
}
hal_spi_bus_t *hal_spi_open_cfg(const hal_spi_cfg_t *cfg)
{
    if(!cfg || cfg->bus_index!=1u || cfg->bits!=8u || cfg->cpol!=1u || cfg->cpha!=1u ||
       !binding_matches() || !rate(cfg->hz)) return NULL;
    s_bus.open=true; return &s_bus;
}
hal_spi_bus_t *hal_spi_open(unsigned index)
{
    const hal_spi_cfg_t cfg={index,1000000u,1,1,8};
    return hal_spi_open_cfg(&cfg);
}
uint32_t hal_spi_set_hz(hal_spi_bus_t *bus,uint32_t max_hz)
{
    if(bus!=&s_bus || !s_bus.open || !binding_matches()) return 0;
    return rate(max_hz);
}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t len)
{
    /* Shared gyro.c needs at most 17 bytes. Fixed bound also caps fault latency. */
    if(bus!=&s_bus || !s_bus.open || cs!=s_bus.cs || !binding_matches() || !len || len>17u) return false;
    return bf_f405_spi_transfer(s_bus.transport,tx,rx,len)==BF_F405_SPI_OK;
}
