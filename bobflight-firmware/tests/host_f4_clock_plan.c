/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "hal/stm32f4/clock_plan.h"

static void valid(bf_f4_part_t part, unsigned mhz, unsigned vdd)
{
    bf_f4_clock_plan_t p;
    assert(bf_f4_make_clock_plan(part, mhz*1000000u, vdd, &p));
    const bool f405 = part == BF_F4_PART_F405;
    assert(p.hse_hz == mhz*1000000u && p.pll_m == mhz);
    assert(p.pll_n == (f405?336:384) && p.pll_p == (f405?2:4));
    assert(p.pll_q == (f405?7:8));
    const uint64_t vco = (uint64_t)p.hse_hz*p.pll_n/p.pll_m;
    assert(vco >= 192000000u && vco <= 432000000u);
    assert(vco/p.pll_p == p.sysclk_hz && vco/p.pll_q == p.usb_hz);
    assert(p.sysclk_hz == (f405?168000000u:96000000u));
    assert(p.usb_hz == 48000000u && p.hclk_hz == p.sysclk_hz && p.ahb_div == 1);
    assert(p.apb1_div == (f405?4:2) && p.apb2_div == (f405?2:1));
    assert(p.apb1_hz == (f405?42000000u:48000000u));
    assert(p.apb2_hz == (f405?84000000u:96000000u));
    assert(p.apb1_timer_hz == (f405?84000000u:96000000u));
    assert(p.apb2_timer_hz == (f405?168000000u:96000000u));
    assert(p.flash_wait_states == (f405?5:3) && p.voltage_scale == 1);
}
static void invalid(bf_f4_part_t part, uint32_t hse, uint32_t vdd)
{
    bf_f4_clock_plan_t p; memset(&p,0xa5,sizeof(p));
    unsigned char before[sizeof(p)];memcpy(before,&p,sizeof(p));
    assert(!bf_f4_make_clock_plan(part,hse,vdd,&p));
    assert(!memcmp(before,&p,sizeof(p)));
}
int main(void)
{
    unsigned valid_cases=0;
    const bf_f4_part_t parts[]={BF_F4_PART_F405,BF_F4_PART_F411};
    const unsigned volts[]={2700,3300,3600};
    for(unsigned i=0;i<2;i++)for(unsigned mhz=4;mhz<=26;mhz++)
        for(unsigned v=0;v<3;v++){valid(parts[i],mhz,volts[v]);valid_cases++;}
    const uint32_t bad_hse[]={0,1,3999999,8000001,25500000,26000001,27000000,UINT32_MAX};
    const uint32_t bad_vdd[]={0,1800,2699,3601,UINT32_MAX};
    for(unsigned i=0;i<2;i++){
        for(unsigned j=0;j<sizeof(bad_hse)/sizeof(bad_hse[0]);j++)invalid(parts[i],bad_hse[j],3300);
        for(unsigned j=0;j<sizeof(bad_vdd)/sizeof(bad_vdd[0]);j++)invalid(parts[i],8000000,bad_vdd[j]);
        assert(!bf_f4_make_clock_plan(parts[i],8000000,3300,NULL));
    }
    invalid((bf_f4_part_t)0,8000000,3300);
    invalid((bf_f4_part_t)407,8000000,3300);
    invalid((bf_f4_part_t)722,8000000,3300);
    printf("PASS: %u accepted F4 planning cases, invalid inputs leave output unchanged; no hardware claim\n",valid_cases);
    return 0;
}
