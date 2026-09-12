/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "hal/cycle_clock.h"
#include <stdio.h>
#include <limits.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"clock FAIL line %d: %s\n",__LINE__,#x);return 1;}}while(0)
int main(void){
 cycle_clock_t c;CHECK(!cycle_clock_init(&c,0,0));CHECK(!cycle_clock_init(&c,16500000,0));
 CHECK(cycle_clock_update(&c,100)==0);
 const uint32_t rates[]={16000000,168000000,216000000};
 for(unsigned h=0;h<3;h++){
  uint32_t per=rates[h]/1000000,raw=UINT32_MAX-31u;
  CHECK(cycle_clock_init(&c,rates[h],raw));
  uint64_t total=0,prior=0;
  for(unsigned i=0;i<80000;i++){
   uint32_t delta=i%7==0?1:rates[h]/1000;
   total+=delta;raw+=delta;uint64_t actual=cycle_clock_update(&c,raw);
   CHECK(actual==total/per&&actual>=prior);prior=actual;
  }
  CHECK(cycle_clock_update(&c,raw)==prior);
  total+=UINT32_MAX;raw+=UINT32_MAX;
  CHECK(cycle_clock_update(&c,raw)==total/per);
  CHECK(cycle_clock_init(&c,rates[h],0));
  for(unsigned i=0;i<per;i++)CHECK(cycle_clock_update(&c,i+1)==(i+1)/per);
 }
 puts("PASS cycle clock: 16/168/216MHz, fractions, duplicates, multi-wrap accumulation, largest delta, reset and invalid frequency");return 0;
}
