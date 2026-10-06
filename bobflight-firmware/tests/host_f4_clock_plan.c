/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "hal/stm32f4/clock_plan.h"

static void preserve(bf_f4_clock_reg_update_t u)
{
    const uint32_t old_values[]={0,UINT32_MAX,0x24003010u,0xa5a5a5a5u,0x5a5a5a5au};
    assert(!(u.value & ~u.mask));
    for(unsigned i=0;i<sizeof(old_values)/sizeof(old_values[0]);i++) {
        const uint32_t before=old_values[i], after=(before & ~u.mask)|u.value;
        assert((after & ~u.mask)==(before & ~u.mask));
        assert((after & u.mask)==u.value);
    }
}
static void registers(bf_f4_part_t part, unsigned mhz, unsigned vdd)
{
    bf_f4_clock_register_plan_t r;
    assert(bf_f4_make_clock_register_plan(part,mhz*1000000u,vdd,&r));
    const bool f405=part==BF_F4_PART_F405;
    assert(r.pllcfgr.mask==0x0f437fffu);
    assert(r.pllcfgr.value==((f405?0x07405400u:0x08416000u)|mhz));
    assert((r.pllcfgr.value & 63u)==r.clocks.pll_m);
    assert(((r.pllcfgr.value>>6)&511u)==r.clocks.pll_n);
    assert(((((r.pllcfgr.value>>16)&3u)+1u)*2u)==r.clocks.pll_p);
    assert(((r.pllcfgr.value>>24)&15u)==r.clocks.pll_q);
    assert(r.cfgr.mask==0x0000fcf0u && r.cfgr.value==(f405?0x9400u:0x1000u));
    assert(!(r.cfgr.mask & 0xfu)); /* Never modify SYSCLK switch/status fields. */
    assert((1u<<(((r.cfgr.value>>10)&7u)-3u))==r.clocks.apb1_div);
    assert(r.clocks.apb2_div==(((r.cfgr.value>>13)&7u)?2u:1u));
    assert(r.pwr_cr.mask==(f405?0x4000u:0xc000u));
    assert(r.pwr_cr.value==r.pwr_cr.mask);
    assert(r.flash_acr.mask==7u && r.flash_acr.value==r.clocks.flash_wait_states);
    preserve(r.pllcfgr);preserve(r.cfgr);preserve(r.pwr_cr);preserve(r.flash_acr);
}
static void valid(bf_f4_part_t part, unsigned mhz, unsigned vdd)
{
    registers(part,mhz,vdd);
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
    bf_f4_clock_register_plan_t r;memset(&r,0xa5,sizeof(r));
    unsigned char reg_before[sizeof(r)];memcpy(reg_before,&r,sizeof(r));
    assert(!bf_f4_make_clock_register_plan(part,hse,vdd,&r));
    assert(!memcmp(reg_before,&r,sizeof(r)));
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
        assert(!bf_f4_make_clock_register_plan(parts[i],8000000,3300,NULL));
    }
    invalid((bf_f4_part_t)0,8000000,3300);
    invalid((bf_f4_part_t)407,8000000,3300);
    invalid((bf_f4_part_t)722,8000000,3300);
    printf("PASS: %u accepted F4 planning/register cases, masked-bit preservation and invalid-output preservation; no hardware claim\n",valid_cases);
    return 0;
}
