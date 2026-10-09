/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* ST RM0090: SPI1 on APB2, CR1 DFF=0, mode 3; OVR clear is DR then SR.
 * Independent implementation. No DMA, IRQ handler, motor, flash or GPIO writes. */
#include "spi_component.h"
#include "timebase.h"
#define RCC_EN (*(volatile uint32_t *)0x40023844u)
#define SPE (1u<<6)
#define RXNE 1u
#define TXE 2u
#define BSY (1u<<7)
#define OVR (1u<<6)
#define MODF (1u<<5)
#define CONTROL(br) (0x307u|((uint32_t)(br)<<3)|SPE)
static bool thread(void) { uint32_t x; __asm volatile("mrs %0, ipsr":"=r"(x)); return x==0; }
static bool masked(void) { uint32_t x; __asm volatile("mrs %0, primask":"=r"(x)); return (x&1u)!=0; }
static bool valid_rate(bf_f405_spi_prescaler_t p) { return (unsigned)p>=6u && (unsigned)p<=7u; }
bool bf_f405_spi_is_ready(const bf_f405_spi_bus_t *b) { return b && b->initialized && !b->in_error && !b->busy; }
static bf_f405_spi_status_t fault(bf_f405_spi_bus_t *b,bf_f405_spi_status_t e)
{
    /* One finite drain, in the RM0090 order. Never wait for a stuck BSY here. */
    (void)*(volatile uint8_t *)&b->regs->DR;
    (void)b->regs->SR;
    b->regs->CR1 &= ~SPE;
    b->in_error=true; b->last_error=e;
    if(b->cs_fn) b->cs_fn(b->cs_ctx,false);
    b->busy=false; return e;
}
static bf_f405_spi_status_t wait_flag(bf_f405_spi_bus_t *b,uint32_t mask,bool set,uint64_t start,bf_f405_spi_status_t timeout)
{
    for(;;) {
        if(b->last_polls>=b->poll_budget) return timeout;
        b->last_polls++;
        uint64_t now;
        if(!bf_f405_time_read_us(&now) || now<start) return BF_F405_SPI_ERR_TIME;
        if(now-start>=b->timeout_us) return timeout;
        b->last_elapsed_us=(uint32_t)(now-start);
        uint32_t sr=b->regs->SR;
        if(sr&OVR) return BF_F405_SPI_ERR_OVERRUN;
        if(sr&MODF) return BF_F405_SPI_ERR_HARDWARE;
        if(((sr&mask)!=0)==set) return BF_F405_SPI_OK;
    }
}
static bf_f405_spi_status_t begin(bf_f405_spi_bus_t *b,uint64_t *start)
{
    if(!b || !b->initialized) return BF_F405_SPI_ERR_UNBOUND;
    if(!thread() || b->busy) return BF_F405_SPI_ERR_CONTEXT;
    if(b->in_error) return b->last_error;
    b->busy=true; b->last_polls=0; b->last_elapsed_us=0;
    if(!bf_f405_time_read_us(start)) return fault(b,BF_F405_SPI_ERR_TIME);
    if(b->regs->CR1!=CONTROL(b->prescaler) || b->regs->CR2!=0 || (b->regs->I2SCFGR&(1u<<11)))
        return fault(b,BF_F405_SPI_ERR_HARDWARE);
    return BF_F405_SPI_OK;
}
bf_f405_spi_status_t bf_f405_spi_init(bf_f405_spi_bus_t *b,bf_f405_spi_regs_t *r,const bf_f4_clock_plan_t *c,bf_f405_spi_prescaler_t p)
{
    if(!b || !c || !valid_rate(p) || (r && r!=BF_F405_SPI1_BASE)) return BF_F405_SPI_ERR_INVALID;
    if(!thread() || !masked()) return BF_F405_SPI_ERR_CONTEXT;
    if(b->initialized) return BF_F405_SPI_ERR_ALREADY;
    if(c->hclk_hz!=168000000u || c->apb2_hz!=84000000u) return BF_F405_SPI_ERR_CLOCK;
    uint64_t now;
    if(!bf_f405_time_read_us(&now)) return BF_F405_SPI_ERR_TIME;
    b->regs=BF_F405_SPI1_BASE; b->prescaler=p; b->poll_budget=10000; b->timeout_us=1000;
    b->initialized=true; b->busy=false; b->in_error=false; b->cs_fn=NULL; b->cs_ctx=NULL;
    b->last_error=BF_F405_SPI_OK; b->last_polls=0; b->last_elapsed_us=0;
    RCC_EN |= 1u<<12; __asm volatile("dsb sy" ::: "memory");
    if(!(RCC_EN&(1u<<12))) { b->in_error=true;return b->last_error=BF_F405_SPI_ERR_CLOCK; }
    /* Do not take over an already configured/active peripheral or I2S port. */
    if(b->regs->CR1 || b->regs->CR2 || (b->regs->I2SCFGR&(1u<<11)) ||
       (b->regs->SR&(RXNE|BSY|OVR|MODF))) {
        b->in_error=true;return b->last_error=BF_F405_SPI_ERR_ALREADY;
    }
    b->regs->CR1=CONTROL(p)&~SPE; b->regs->CR2=0; b->regs->CR1=CONTROL(p);
    if(b->regs->CR1!=CONTROL(p) || b->regs->CR2) return fault(b,BF_F405_SPI_ERR_HARDWARE);
    return BF_F405_SPI_OK;
}
bf_f405_spi_status_t bf_f405_spi_transfer(bf_f405_spi_bus_t *b,const uint8_t *tx,uint8_t *rx,size_t n)
{
    if(!n || n>BF_F405_SPI_MAX_TRANSFER) return BF_F405_SPI_ERR_INVALID;
    uint64_t start; bf_f405_spi_status_t e=begin(b,&start);
    if(e) return e;
    /* No stale receive byte may become the first byte of a new transaction. */
    e=wait_flag(b,BSY,false,start,BF_F405_SPI_ERR_STUCK_BSY);
    if(e) return fault(b,e);
    if(b->regs->SR&RXNE) return fault(b,BF_F405_SPI_ERR_HARDWARE);
    if(b->cs_fn) b->cs_fn(b->cs_ctx,true);
    for(size_t i=0;i<n;i++) {
        e=wait_flag(b,TXE,true,start,BF_F405_SPI_ERR_STUCK_TXE); if(e) return fault(b,e);
        *(volatile uint8_t *)&b->regs->DR=tx?tx[i]:0xffu;
        e=wait_flag(b,RXNE,true,start,BF_F405_SPI_ERR_STUCK_RXNE); if(e) return fault(b,e);
        uint8_t value=*(volatile uint8_t *)&b->regs->DR; if(rx) rx[i]=value;
    }
    e=wait_flag(b,TXE,true,start,BF_F405_SPI_ERR_STUCK_TXE); if(e) return fault(b,e);
    e=wait_flag(b,BSY,false,start,BF_F405_SPI_ERR_STUCK_BSY); if(e) return fault(b,e);
    if(b->cs_fn) b->cs_fn(b->cs_ctx,false);
    b->busy=false; return BF_F405_SPI_OK;
}
bf_f405_spi_status_t bf_f405_spi_set_prescaler(bf_f405_spi_bus_t *b,bf_f405_spi_prescaler_t p)
{
    if(!valid_rate(p)) return BF_F405_SPI_ERR_INVALID;
    uint64_t start; bf_f405_spi_status_t e=begin(b,&start); if(e) return e;
    e=wait_flag(b,TXE,true,start,BF_F405_SPI_ERR_STUCK_TXE); if(e) return fault(b,e);
    e=wait_flag(b,BSY,false,start,BF_F405_SPI_ERR_STUCK_BSY); if(e) return fault(b,e);
    if(b->regs->SR&RXNE) return fault(b,BF_F405_SPI_ERR_HARDWARE);
    b->regs->CR1 &= ~SPE; b->regs->CR1=CONTROL(p)&~SPE; b->regs->CR1=CONTROL(p);
    if(b->regs->CR1!=CONTROL(p)) return fault(b,BF_F405_SPI_ERR_HARDWARE);
    b->prescaler=p; b->busy=false; return BF_F405_SPI_OK;
}
bf_f405_spi_status_t bf_f405_spi_set_timeouts(bf_f405_spi_bus_t *b,uint32_t polls,uint32_t us)
{
    if(!thread() || !bf_f405_spi_is_ready(b)) return BF_F405_SPI_ERR_CONTEXT;
    if(!polls || polls>1000000u || !us || us>100000u) return BF_F405_SPI_ERR_INVALID;
    b->poll_budget=polls; b->timeout_us=us; return BF_F405_SPI_OK;
}
bf_f405_spi_status_t bf_f405_spi_set_cs_callback(bf_f405_spi_bus_t *b,bf_f405_spi_cs_fn_t fn,void *ctx)
{
    if(!thread() || !bf_f405_spi_is_ready(b)) return BF_F405_SPI_ERR_CONTEXT;
    b->cs_fn=fn; b->cs_ctx=ctx; return BF_F405_SPI_OK;
}
