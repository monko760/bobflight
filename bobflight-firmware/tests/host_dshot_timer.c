/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Execute the real HAL start sequence against a small timer/preload/DMA model.
 * No physical waveform claim. Model: PWM1 is active at CNT < active CCR even
 * while CEN=0; UG loads preload registers; each timed update loads preloads
 * before issuing DMA requests. Register changes are committed at the next
 * MMIO access (and explicit flush) to instrument C lvalue writes.
 */
#include "hal/hal.h"
#include "board/board.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

static uint32_t tr[2][32], dr[2][64], active[2][4];
static uint32_t *previous;
static unsigned early_high;
static uint32_t core_hz=168000000u;
static struct {uint32_t AHB1ENR,APB1ENR,APB2ENR;} fake_rcc;
static void flush_io(void);
static uint32_t *test_register(uintptr_t base,unsigned offset);
/* Avoid native MMIO and ARM CMSIS in this host-only inclusion of the HAL. */
#define BOBFLIGHT_HAL_F7_PRIV_H
#define HAL_F7_RCC (&fake_rcc)
#define R(base,offset) (*test_register((base),(offset)))
#define __DMB() flush_io()
static uint32_t hal_f7_timclk(bool apb2){return apb2?core_hz:core_hz/2u;}
#include "../src/hal/stm32f7/hal_tim_dma.c"

static board_t board={.board_id="kakute_f7_hdv",.motor_count=4,.motors={
    {HAL_PIN_PACK(1,0),3,3},{HAL_PIN_PACK(1,1),3,4},
    {HAL_PIN_PACK(4,9),1,1},{HAL_PIN_PACK(4,11),1,2}}};
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return true;}
bool hal_gpio_configure(hal_pin_t p,const hal_gpio_cfg_t *cfg){(void)p;(void)cfg;return true;}

static void flush_io(void){
    if(!previous)return;
    for(unsigned g=0;g<2;g++){
        if(previous==&tr[g][0x14/4] && (*previous&1u)){
            for(unsigned c=0;c<4;c++)active[g][c]=tr[g][(0x34+c*4)/4];
            tr[g][0x24/4]=0;*previous=0; /* write-only UG bit */
        }
        /* Observe any high PWM output during CPU setup, before counter start. */
        if(!(tr[g][0]&1u) && (!g || (tr[g][0x44/4]&(1u<<15)))){
            for(unsigned c=0;c<4;c++)
                if((tr[g][0x20/4]&(1u<<(c*4))) && active[g][c]>tr[g][0x24/4])early_high++;
        }
    }
    previous=NULL;
}
static uint32_t *test_register(uintptr_t base,unsigned offset){
    flush_io();uint32_t *result=NULL;
    for(unsigned g=0;g<2;g++){
        if(base==timers[g]){assert(offset<sizeof(tr[g]));result=&tr[g][offset/4];}
        if(base>=dmas[g] && base+offset<dmas[g]+sizeof(dr[g]))result=&dr[g][(base-dmas[g]+offset)/4];
    }
    assert(result);previous=result;return result;
}
static void timed_update(unsigned g){
    for(unsigned c=0;c<4;c++)active[g][c]=tr[g][(0x34+c*4)/4];
    unsigned off=(unsigned)(stream(g)-dmas[g])/4;
    if((tr[g][0x0C/4]&(1u<<8)) && (dr[g][off]&1u)){
        assert(dr[g][off+2]==(uint32_t)(timers[g]+0x4C));
        assert(dr[g][off+1]>=4);
        uint32_t start=(uint32_t)(uintptr_t)&frames[g][0][0];
        unsigned index=(dr[g][off+3]-start)/sizeof(uint16_t);
        assert(index+4<=80);
        for(unsigned c=0;c<4;c++)tr[g][(0x34+c*4)/4]=((uint16_t*)frames[g])[index+c];
        dr[g][off+3]+=4*sizeof(uint16_t);dr[g][off+1]-=4;
        if(!dr[g][off+1])dr[g][off]&=~1u;
    }
}
#define CHECK(c) do{if(!(c)){fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#c);return 1;}}while(0)
int main(void){
    hal_tim_dma_t *handles[4];
    for(unsigned i=0;i<4;i++){
        hal_tim_dma_cfg_t cfg={.tim=board.motors[i].timer,.channel=board.motors[i].channel,.pin=board.motors[i].pin,.bit_hz=300000u};
        handles[i]=hal_tim_dma_open_cfg(&cfg);CHECK(handles[i]);
    }
    flush_io();CHECK(!early_high);
    for(unsigned clock=0;clock<2;clock++)for(unsigned rate=0;rate<2;rate++){
        core_hz=clock?216000000u:168000000u;
        /* Change rates to force recomputation after changing the model clock. */
        CHECK(hal_tim_dma_set_bit_rate(rate?300000u:600000u));
        CHECK(hal_tim_dma_set_bit_rate(rate?600000u:300000u));
        flush_io();
        for(unsigned repeat=0;repeat<4;repeat++){
            uint16_t words[4][20];
            const uint16_t pattern[4]={0x0000,0x8000,0x5555,0xFFFF};
            for(unsigned i=0;i<4;i++){
                for(unsigned j=0;j<20;j++)words[i][j]=j<16?((pattern[(i+repeat)%4]>>(15-j))&1u?6:3):0;
                CHECK(hal_tim_dma_start_burst(handles[i],words[i],20));
            }
            flush_io();CHECK(!early_high); /* regression: baseline fails here */
            for(unsigned g=0;g<2;g++){
                for(unsigned c=0;c<4;c++)CHECK(active[g][c]==0);
                unsigned off=(unsigned)(stream(g)-dmas[g])/4;
                CHECK(dr[g][off+1]==19u*4u);
                CHECK(dr[g][off+3]==(uint32_t)(uintptr_t)&frames[g][1][0]);
                CHECK(tr[g][0x2C/4]+1==hal_f7_timclk(g==1)/bit_rate);
                for(unsigned j=0;j<20;j++){
                    timed_update(g);
                    for(unsigned c=0;c<4;c++)CHECK(active[g][c]==frames[g][j][c]);
                }
                CHECK(!(dr[g][off]&1u));CHECK(dr[g][off+1]==0);
                timed_update(g);for(unsigned c=0;c<4;c++)CHECK(active[g][c]==0);
            }
        }
    }
    stop();flush_io();CHECK(!early_high);
    puts("PASS: real HAL setup stays low; all 16 bits + four idle slots follow timed updates at 168/216 MHz and DShot300/600, repeated frames and stop");
    return 0;
}
