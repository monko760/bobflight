/* SPDX-License-Identifier: Apache-2.0
 * Shared STM32F7 timer burst TX; board IR supplies pin/timer/channel tuples.
 * Kakute: TIM3 CH3/4 + TIM1 CH1/2. Matek PX: TIM8 CH3/4 + TIM3 CH1/2.
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
static uintptr_t timers[2]={0x40000400u,0x40010000u};
static uintptr_t dmas[2]={0x40026000u,0x40026400u};
static unsigned streams[2]={2,5}, channels[2]={5,6};
static uint32_t periods[2];
static uint32_t bit_rate = 300000u; /* DShot300 default; 600000 for DShot600 */
/* Bidirectional DShot: inverted line (idle high, pull-up), BDShot public
 * protocol. CCxP on the four motor channels; set before configure() too. */
static bool inverted;
static uint32_t ccer_on[2]={0x1100u,0x11u}, ccer_pol[2]={(1u<<9)|(1u<<13),(1u<<1)|(1u<<5)};
static bool apb2[2]={false,true},advanced[2]={false,true},ic_coupled;
static unsigned motor_group[4],motor_cc[4],motor_af[4],group_count;
/* RM0431/RM0385 update requests. No per-channel DMA OR request ambiguity. */
typedef struct {unsigned tim;uintptr_t base,dma;unsigned stream,chsel;bool apb2,advanced;unsigned enable_bit;} tx_route_t;
static const tx_route_t routes[]={
 {3,0x40000400u,0x40026000u,2,5,false,false,1},
 {1,0x40010000u,0x40026400u,5,6,true,true,0},
 {8,0x40010400u,0x40026400u,1,7,true,true,1}
};
static unsigned pin_af(unsigned tim,unsigned ch,hal_pin_t p){
 if(tim==3&&((ch==1&&p==HAL_PIN_PACK(1,4))||(ch==2&&p==HAL_PIN_PACK(1,5))||(ch==3&&p==HAL_PIN_PACK(1,0))||(ch==4&&p==HAL_PIN_PACK(1,1))))return 2;
 if(tim==1&&((ch==1&&p==HAL_PIN_PACK(4,9))||(ch==2&&p==HAL_PIN_PACK(4,11))))return 1;
 if(tim==8&&((ch==3&&p==HAL_PIN_PACK(2,8))||(ch==4&&p==HAL_PIN_PACK(2,9))))return 3;
 return 0;
}
static bool bind_routes(const board_t *b){
 if(!b||b->motor_count<4)return false;
 unsigned ids[2]={0,0};group_count=0;ccer_on[0]=ccer_on[1]=ccer_pol[0]=ccer_pol[1]=0;
 for(unsigned i=0;i<4;i++){
  unsigned tim=b->motors[i].timer,ch=b->motors[i].channel,af=pin_af(tim,ch,b->motors[i].pin);
  if(!af)return false;
  for(unsigned j=0;j<i;j++)if(b->motors[j].pin==b->motors[i].pin||(b->motors[j].timer==tim&&b->motors[j].channel==ch))return false;
  unsigned g=0;while(g<group_count&&ids[g]!=tim)g++;
  if(g==group_count){if(g>=2)return false;const tx_route_t *r=NULL;for(unsigned j=0;j<sizeof routes/sizeof routes[0];j++)if(routes[j].tim==tim)r=&routes[j];if(!r)return false;
   ids[g]=tim;timers[g]=r->base;dmas[g]=r->dma;streams[g]=r->stream;channels[g]=r->chsel;apb2[g]=r->apb2;advanced[g]=r->advanced;group_count++;}
  motor_group[i]=g;motor_cc[i]=ch-1;motor_af[i]=af;ccer_on[g]|=1u<<((ch-1)*4);ccer_pol[g]|=1u<<((ch-1)*4+1);
 }
 if(group_count!=2)return false;
 /* Existing capture backend is explicitly Kakute-only, never called for Matek timers. */
 ic_coupled=!strcmp(b->board_id,"kakute_f7_hdv")&&ids[0]==3&&ids[1]==1;
 return true;
}
static void quiesce(unsigned g){if(ic_coupled)hal_f7_dshot_ic_quiesce(g);}
static bool disable_stream(unsigned g){uintptr_t s=dmas[g]+0x10u+0x18u*streams[g];R(s,0)&=~1u;for(unsigned n=0;n<64;n++)if(!(R(s,0)&1u))return true;return false;}
static void apply_pins(const board_t *b) {
    for(unsigned i=0;i<4;i++) {
        hal_gpio_cfg_t af={HAL_GPIO_AF,inverted?HAL_GPIO_PULL_UP:HAL_GPIO_PULL_DOWN,HAL_GPIO_SPEED_VERYHIGH,(uint8_t)motor_af[i]};
        (void)hal_gpio_configure(b->motors[i].pin,&af);
    }
}
static uintptr_t stream(unsigned group){return dmas[group]+0x10u+0x18u*streams[group];}
static void stop(void) {
    pending=0;
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g]; R(t,0x0C)=0; R(t,0)=0;
        for(unsigned c=0;c<4;c++) R(t,0x34+c*4)=0;
        R(t,0x14)=1; (void)disable_stream(g);
    }
}
static bool configure(void) {
    const board_t *b=board_get();
    if(!board_mmio_permitted() || !bind_routes(b)) return false;
    HAL_F7_RCC->AHB1ENR |= (1u<<21)|(1u<<22);
    for(unsigned g=0;g<2;g++)for(unsigned j=0;j<sizeof routes/sizeof routes[0];j++)if(routes[j].base==timers[g]){if(apb2[g])HAL_F7_RCC->APB2ENR|=1u<<routes[j].enable_bit;else HAL_F7_RCC->APB1ENR|=1u<<routes[j].enable_bit;}
    (void)HAL_F7_RCC->APB2ENR;
    for(unsigned g=0;g<2;g++) {
        uintptr_t t=timers[g]; R(t,0)=0; R(t,0x0C)=0;
        periods[g]=hal_f7_timclk(apb2[g])/bit_rate;
        if(periods[g]<8) return false;
        R(t,0x28)=0; R(t,0x2C)=periods[g]-1;
        R(t,0x18)=0x6868; R(t,0x1C)=0x6868; /* PWM1 + CCR preload */
        R(t,0x20)=ccer_on[g]|(inverted?ccer_pol[g]:0u); /* only actual motor channels */
        if(advanced[g]) R(t,0x44)=1u<<15; /* TIM1 main output enable */
        R(t,0x48)=13u|(3u<<8); /* CCR1 index, four transfers */
        for(unsigned c=0;c<4;c++)R(t,0x34+c*4)=0;
        R(t,0x14)=1;
    }
    for(unsigned i=0;i<4;i++) {
        hal_gpio_cfg_t af={HAL_GPIO_AF,inverted?HAL_GPIO_PULL_UP:HAL_GPIO_PULL_DOWN,HAL_GPIO_SPEED_VERYHIGH,(uint8_t)motor_af[i]};
        if(!hal_gpio_configure(b->motors[i].pin,&af)) {stop();return false;}
    }
    memset(frames,0,sizeof(frames)); initialized=true; return true;
}
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg) {
    const board_t *b=board_get();
    if(!cfg || !b || !board_mmio_permitted() || cfg->bit_hz!=bit_rate) return 0;
    for(unsigned i=0;i<4&&i<b->motor_count;i++)if(cfg->pin==b->motors[i].pin&&cfg->tim==b->motors[i].timer&&cfg->channel==b->motors[i].channel){
        if(!initialized&&!configure())return 0;
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
        quiesce(g);
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
        periods[g]=hal_f7_timclk(apb2[g])/bit_rate;
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
            quiesce(g); /* B2: DMA1 S2 doubles as M2 capture */
            if((R(dmas[g],st<4?0:4)&(0x0Du<<shift)) || (R(s,0)&1u)) {stop();return false;}
        }
    }
    unsigned i=slot->index;if(i>=4)return false;unsigned g=motor_group[i],c=motor_cc[i];
    for(unsigned j=0;j<20;j++)frames[g][j][c]=(uint16_t)((uint32_t)words[j]*periods[g]/8u);
    pending|=1u<<i;
    if(pending!=15)return true;
    pending=0;
    for(g=0;g<2;g++) {
        uintptr_t t=timers[g],s=stream(g); unsigned st=streams[g];
        /* B2: a capture window still open (bidir) is closed before TX. */
        quiesce(g);
        uint32_t tcie=(ic_coupled&&hal_f7_dshot_ic_tc_irq_wanted(g))?(1u<<4):0u;
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
        if(!disable_stream(g)){stop();return false;}
        R(s,0)=0;R(s,4)=19u*4u;R(s,8)=(uint32_t)(t+0x4C);
        R(s,12)=(uint32_t)(uintptr_t)&frames[g][1][0];R(s,20)=0;
#if defined(BOBFLIGHT_HAVE_CMSIS)
        /* DMA cannot snoop Cortex-M7 D-cache. Whole rows are 32-byte aligned. */
        if(SCB->CCR & SCB_CCR_DC_Msk)SCB_CleanDCache_by_Addr((void *)&frames[g][0][0],(int32_t)sizeof frames[g]);
        __DSB();
#endif
        __DMB();
        /* TCIE only when a bidir capture is armed: the TC IRQ opens the
         * input-capture window right after the frame (hal_tim_ic.c). */
        R(s,0)=(channels[g]<<25)|(2u<<16)|(1u<<13)|(1u<<11)|(1u<<10)|(1u<<6)|tcie|1u;
        R(t,0x0C)=1u<<8; R(t,0)=(1u<<7)|1u;
    }
    return true;
}
