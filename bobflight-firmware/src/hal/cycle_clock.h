/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_CYCLE_CLOCK_H
#define BOBFLIGHT_CYCLE_CLOCK_H
#include <stdint.h>
#include <stdbool.h>
/* Caller serializes updates. Must sample more often than one 32-bit cycle
 * wrap. SysTick does this every millisecond on supported running F7 hardware.
 * No elapsed-time claim for debugger halts, sleep, or runtime clock changes. */
typedef struct {uint64_t us;uint32_t last,cycles_per_us,remainder;} cycle_clock_t;
static inline bool cycle_clock_init(cycle_clock_t *c,uint32_t hz,uint32_t cycles){
 *c=(cycle_clock_t){0};c->last=cycles;
 if(hz<1000000u || hz%1000000u)return false;
 c->cycles_per_us=hz/1000000u;return true;
}
static inline uint64_t cycle_clock_update(cycle_clock_t *c,uint32_t cycles){
 if(!c->cycles_per_us)return c->us;
 uint32_t delta=cycles-c->last;c->last=cycles;
 uint32_t whole=delta/c->cycles_per_us;
 uint32_t fraction=delta%c->cycles_per_us+c->remainder;
 if(fraction>=c->cycles_per_us){whole++;fraction-=c->cycles_per_us;}
 c->remainder=fraction;c->us+=whole;return c->us;
}
#endif
