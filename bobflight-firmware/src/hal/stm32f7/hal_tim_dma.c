/* SPDX-License-Identifier: Apache-2.0
 * Kakute F7 HDV: TIM3 CH3/4 (PB0/1), TIM1 CH1/2 (PE9/11).
 * RM0385 TIMx_DCR burst transfers CCR1..4 on update; normal-mode DMA.
 * TIM3_UP: DMA1 stream2/channel5; TIM1_UP: DMA2 stream5/channel6.
 * Bidir (B2): inverted polarity + pull-up, TCIE hands off to hal_tim_ic.c.
 * No CPU bit-banging, no DMA reads from inaccessible DTCM. */
#include "hal_f7_priv.h"
#include "board/board.h"
#include <string.h>
#ifndef R
#define R(base,offset) (*(volatile uint32_t*)((uintptr_t)(base)+(offset)))
#endif
struct hal_tim_dma {unsigned index; bool open;};
static hal_tim_dma_t slots[4];
static unsigned pending;
static bool initialized;
static uint16_t frames[2][20][4] __attribute__((section(".dma"),aligned(32)));
static const uintptr_t timers[2]={0x40000400u,0x40010000u};
static const uintptr_t dmas[2]={0x40026000u,0x40026400u};
static const unsigned streams[2]={2,5}, channels[2]={5,6};
static uint32_t periods[2];
static uint32_t bit_rate = 300000u; /* DShot300 default; 600000 for DShot600 */
/* Bidirectional DShot: inverted line (idle high, pull-up), BDShot public
 * protocol. CCxP on the four motor channels; set before configure() too. */
static bool inverted;
static const uint32_t ccer_on[2]={0x1100u,0x11u}, ccer_pol[2]={(1u<<9)|(1u<<13),(1u<<1)|(1u<<5)};
static void apply_pins(const board_t *b) {
    for(unsigned i=0;i<4;i++) {
        hal_gpio_cfg_t af={HAL_GPIO_AF,inverted?HAL_GPIO_PULL_UP:HAL_GPIO_PULL_DOWN,HAL_GPIO_SPEED_VERYHIGH,(uint8_t)(i<2?2:1)};
        (void)hal_gpio_configure(b->motors[i].pin,&af);
    }
}
static uintptr_t stream(unsigned group){return dmas[group]+0x10u+0x18u*streams[group];}
static void stop(void) {
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g]; R(t,0x0C)=0; R(t,0)=0;
        for(unsigned c=0;c<4;c++) R(t,0x34+c*4)=0;
        R(t,0x14)=1; R(stream(g),0)&=~1u;
    }
}
static bool configure(void) {
    const board_t *b=board_get();
    if(!board_mmio_permitted() || strcmp(b->board_id,"kakute_f7_hdv")) return false;
    HAL_F7_RCC->AHB1ENR |= (1u<<21)|(1u<<22); HAL_F7_RCC->APB1ENR |= 1u<<1; HAL_F7_RCC->APB2ENR |= 1;
    (void)HAL_F7_RCC->APB2ENR;
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g]; R(t,0)=0; R(t,0x0C)=0;
        periods[g]=hal_f7_timclk(g==1)/bit_rate;
        if(periods[g]<8) return false;
        R(t,0x28)=0; R(t,0x2C)=periods[g]-1;
        R(t,0x18)=0x6868; R(t,0x1C)=0x6868; /* PWM1 + CCR preload */
        R(t,0x20)=ccer_on[g]|(inverted?ccer_pol[g]:0u); /* only actual motor channels */
        if(g) R(t,0x44)=1u<<15; /* TIM1 main output enable */
        R(t,0x48)=13u|(3u<<8); /* CCR1 index, four transfers */
        for(unsigned c=0;c<4;c++)R(t,0x34+c*4)=0;
        R(t,0x14)=1;
    }
    for(unsigned i=0;i<4;i++) {
        hal_gpio_cfg_t af={HAL_GPIO_AF,inverted?HAL_GPIO_PULL_UP:HAL_GPIO_PULL_DOWN,HAL_GPIO_SPEED_VERYHIGH,(uint8_t)(i<2?2:1)};
        if(!hal_gpio_configure(b->motors[i].pin,&af)) {stop();return false;}
    }
    memset(frames,0,sizeof(frames)); initialized=true; return true;
}
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg) {
    const board_t *b=board_get();
    if(!cfg || !b || !board_mmio_permitted() || cfg->bit_hz!=bit_rate) return 0;
    static const unsigned tim[4]={3,3,1,1},ch[4]={3,4,1,2};
    static const hal_pin_t pins[4]={HAL_PIN_PACK(1,0),HAL_PIN_PACK(1,1),HAL_PIN_PACK(4,9),HAL_PIN_PACK(4,11)};
    for(unsigned i=0;i<4;i++)if(cfg->pin==pins[i] && cfg->tim==tim[i] && cfg->channel==ch[i]) {
        if(!initialized && !configure())return 0;
        slots[i].index=i;slots[i].open=true;return &slots[i];
    }
    return 0;
}
hal_tim_dma_t *hal_tim_dma_open(unsigned tim,unsigned ch){(void)tim;(void)ch;return 0;}
void hal_tim_dma_set_inverted(bool inv) {
    if(inv==inverted) return;
    inverted=inv;
    if(!initialized || !board_mmio_permitted()) return; /* picked up by configure() */
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g];
        hal_f7_dshot_ic_quiesce(g);
        R(t,0x20)=(R(t,0x20)&~ccer_pol[g])|(inverted?ccer_pol[g]:0u);
    }
    apply_pins(board_get());
}
bool hal_tim_dma_set_bit_rate(uint32_t hz) {
    if(hz!=300000u && hz!=600000u) return false;
    if(hz==bit_rate) return true;
    bit_rate=hz;
    if(!initialized) return true; /* picked up by configure() later */
    /* Re-time: stop bursts, recompute ARR, keep CCR scaling consistent. */
    stop(); pending=0;
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g];
        periods[g]=hal_f7_timclk(g==1)/bit_rate;
        if(periods[g]<8u) return false;
        R(t,0x2C)=periods[g]-1;
        R(t,0x14)=1;
    }
    return true;
}
bool hal_tim_dma_start_burst(hal_tim_dma_t *slot,const uint16_t *words,size_t n) {
    if(!slot || !slot->open || !words || n!=20)return false;
    if(!pending) {
        for(unsigned g=0;g<2;g++) {
            uintptr_t s=stream(g); unsigned st=streams[g];
            unsigned shift=(st%4==0?0:st%4==1?6:st%4==2?16:22);
            hal_f7_dshot_ic_quiesce(g); /* B2: DMA1 S2 doubles as M2 capture */
            if((R(dmas[g],st<4?0:4)&(0x0Du<<shift)) || (R(s,0)&1u)) {stop();return false;}
        }
    }
    unsigned i=slot->index,g=i<2?0:1,c=i<2?i+2:i-2;
    for(unsigned j=0;j<20;j++)frames[g][j][c]=(uint16_t)((uint32_t)words[j]*periods[g]/8u);
    pending|=1u<<i;
    if(pending!=15)return true;
    pending=0;
    for(g=0;g<2;g++) {
        uintptr_t t=timers[g],s=stream(g); unsigned st=streams[g];
        /* B2: a capture window still open (bidir) is closed before TX. */
        hal_f7_dshot_ic_quiesce(g);
        uint32_t tcie=hal_f7_dshot_ic_tc_irq_wanted(g)?(1u<<4):0u;
        unsigned shift=(st%4==0?0:st%4==1?6:st%4==2?16:22);
        R(t,0)=0;R(t,0x0C)=0;
        R(dmas[g],st<4?8:12)=0x3Du<<shift;
        /* PWM1 can drive high at CNT=0 even with CEN=0. Latching bit zero
         * here would stretch its pulse through the remaining CPU setup.
         * Keep the ACTIVE compares at zero; only a TIMED update may start
         * the first data bit. This adds one leading, all-low bit period. */
        for(unsigned k=0;k<4;k++)R(t,0x34+k*4)=0;
        R(t,0x14)=1; R(t,0x10)=0; R(t,0x24)=0;
        /* First timed update latches bit 0, then DMA preloads bit 1.
         * Subsequent updates latch bits 1..15 and the four idle slots. */
        for(unsigned k=0;k<4;k++)R(t,0x34+k*4)=frames[g][0][k];
        R(s,0)=0;R(s,4)=19u*4u;R(s,8)=(uint32_t)(t+0x4C);
        R(s,12)=(uint32_t)(uintptr_t)&frames[g][1][0];R(s,20)=0;
        __DMB();
        /* TCIE only when a bidir capture is armed: the TC IRQ opens the
         * input-capture window right after the frame (hal_tim_ic.c). */
        R(s,0)=(channels[g]<<25)|(2u<<16)|(1u<<13)|(1u<<11)|(1u<<10)|(1u<<6)|tcie|1u;
        R(t,0x0C)=1u<<8; R(t,0)=(1u<<7)|1u;
    }
    return true;
}
