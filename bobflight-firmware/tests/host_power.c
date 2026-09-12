/* SPDX-License-Identifier: Apache-2.0 */
#include "drivers/power.h"
#include "hal/hal.h"
#include <assert.h>
#include <math.h>
#include <string.h>
void hal_power_adc_init(hal_pin_t a,hal_pin_t b){(void)a;(void)b;}
bool hal_power_adc_poll(uint16_t *a,uint16_t *b){(void)a;(void)b;return false;}
uint32_t hal_millis(void){return 0;}
int main(void){
    power_init(); assert(!power_state()->valid);
    power_sample(0,0,0); assert(!power_state()->present);
    power_sample(50,2707,0); assert(power_state()->present); assert(!power_state()->current_valid);
    assert(!strcmp(power_warning(),"set_cells"));
    power_config_t c=*power_config(); c.cells=6;c.current_mv_per_amp=10;
    assert(power_configure(&c));
    power_sample(100,2707,124); /* ~24 V, ~10 A */
    assert(fabsf(power_state()->voltage-24)<0.02f);
    for(unsigned t=150;t<=360100;t+=50) power_sample(t,2707,124);
    assert(fabsf(power_state()->consumed_mah-1000)<2);
    assert(!strcmp(power_warning(),"ok"));
    power_expire(360601);assert(!power_state()->valid);assert(!power_state()->consumption_valid);
    power_sample(360650,2707,124);assert(power_state()->valid);assert(!power_state()->consumption_valid);
    power_sample(360700,0,0);assert(!power_state()->present);assert(power_state()->consumed_mah==0);
    power_sample(360750,2707,124);assert(power_state()->consumption_valid);
    c.voltage_scale=NAN;assert(!power_configure(&c));
    c=*power_config();c.cells=7;assert(!power_configure(&c));
    c=*power_config();c.critical_cell_v=c.warning_cell_v;assert(!power_configure(&c));
    c=*power_config();assert(power_configure(&c));
    power_sample(0xfffffff0u,2707,124); power_sample(34u,2707,124);
    assert(power_state()->consumption_valid);assert(power_state()->consumed_mah>0);
    power_sample(84u,4095,124);assert(!power_state()->valid);
    c=*power_config();assert(power_configure(&c));power_sample(0,2166,124);
    assert(!strcmp(power_warning(),"critical"));
    c=*power_config();assert(power_configure(&c));power_sample(0,2301,124);
    assert(!strcmp(power_warning(),"low"));
    return 0;
}
