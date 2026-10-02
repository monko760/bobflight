/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * F2 blackbox status readouts (blackbox_health.h): missed_pct formula and
 * rounding (identical to drop_pct's), zero denominator, the 1.00 threshold on
 * the printed value, and logged_hz availability/rounding. */
#include "flight/blackbox_health.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
/* blackbox_cli.h drop_pct expression, verbatim (drop_pct is frozen, untouched). */
static unsigned long drop_pct_tenths(uint64_t frames,uint64_t dropped){
 uint64_t total=frames+dropped;return total?(unsigned long)((dropped*1000u+total/2u)/total):0ul;
}
static const char *pct(uint32_t t,char *b){sprintf(b,"%lu.%lu",(unsigned long)(t/10u),(unsigned long)(t%10u));return b;}
static uint32_t missed_pct(uint64_t frames,uint64_t dropped,uint64_t missed){return bb_pct_tenths(missed,frames+dropped+missed);}
int main(void){
 char b[32];
 /* Formula: missed / (frames + dropped + missed); zero denominator prints 0.0 like drop_pct. */
 assert(missed_pct(0,0,0)==0&&!strcmp(pct(missed_pct(0,0,0),b),"0.0")&&drop_pct_tenths(0,0)==0);
 assert(missed_pct(0,0,7)==1000&&!strcmp(pct(1000,b),"100.0"));
 assert(missed_pct(19683,0,0)==0);
 assert(missed_pct(15983,0,3700)==188);                 /* pre-fix QA F2 run: 18.8 % */
 assert(missed_pct(9687,0,81)==8);                      /* 1000/1 with 9 x 10.5 ms stalls: 0.8 % */
 assert(missed_pct(900,50,50)==50&&missed_pct(950,0,50)==50); /* dropped counts in the denominator */
 assert(missed_pct(999,1,0)==0);                        /* drops are not missed */
 /* Same rounding as drop_pct for every split (half up), so the two never disagree in format. */
 srand(7);
 for(unsigned n=0;n<200000;n++){
  uint64_t f=(uint64_t)rand()%50000u,d=(uint64_t)rand()%3000u,m=(uint64_t)rand()%3000u;
  if(n<4000){f=n%97u;d=n%13u;m=n%11u;}
  assert(bb_pct_tenths(m,f+d+m)==drop_pct_tenths(f+d,m));
  assert(bb_pct_tenths(d,f+d)==drop_pct_tenths(f,d));
 }
 /* Threshold: high only when the PRINTED pct is above 1.0. */
 assert(missed_pct(99,0,1)==10&&!strcmp(pct(10,b),"1.0")&&!bb_missed_high(missed_pct(99,0,1)));       /* exactly 1.00 % -> ok */
 assert(missed_pct(9896,0,104)==10&&!bb_missed_high(missed_pct(9896,0,104)));                       /* 1.04 % prints 1.0 -> ok */
 assert(missed_pct(9895,0,105)==11&&!strcmp(pct(11,b),"1.1")&&bb_missed_high(missed_pct(9895,0,105))); /* 1.05 % prints 1.1 -> high */
 assert(missed_pct(989,0,11)==11&&bb_missed_high(missed_pct(989,0,11)));                            /* 1.1 % -> high */
 assert(!bb_missed_high(0)&&!bb_missed_high(10)&&bb_missed_high(11)&&bb_missed_high(1000));
 for(uint32_t t=0;t<=1000;t++)assert(bb_missed_high(t)==(atof(pct(t,b))>1.00));
 /* logged_hz: unavailable when not recording or before 1 s; tenths of Hz, half up. */
 uint32_t hz=12345;
 assert(!bb_logged_hz_tenths(false,20000,20000000u,&hz)&&hz==12345);
 assert(!bb_logged_hz_tenths(true,999,999999u,&hz)&&hz==12345);
 assert(!bb_logged_hz_tenths(true,0,0,&hz)&&!bb_logged_hz_tenths(true,1000,1000000u,NULL));
 assert(bb_logged_hz_tenths(true,1000,1000000u,&hz)&&hz==10000&&!strcmp(pct(hz,b),"1000.0"));
 assert(bb_logged_hz_tenths(true,10001,10000000u,&hz)&&hz==10001&&!strcmp(pct(hz,b),"1000.1"));
 assert(bb_logged_hz_tenths(true,19683,19683000u-1968u,&hz)&&hz==10001);
 assert(bb_logged_hz_tenths(true,1,3000000u,&hz)&&hz==3);       /* 0.333 Hz -> 0.3 */
 assert(bb_logged_hz_tenths(true,1,4000000u,&hz)&&hz==3);       /* 0.25 Hz -> 0.3 (half up) */
 assert(bb_logged_hz_tenths(true,0,5000000u,&hz)&&hz==0);
 assert(bb_logged_hz_tenths(true,UINT32_MAX,1000000u,&hz)&&hz==UINT32_MAX); /* clamped, never wraps */
 puts("PASS blackbox health: missed_pct = missed/(frames+dropped+missed) with drop_pct's rounding/format and 0.0 zero denominator; missed_state high only above the printed 1.0; logged_hz unavailable when not recording or < 1 s, tenths half up, clamped");
 return 0;
}
