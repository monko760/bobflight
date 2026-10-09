/* SPDX-License-Identifier: Apache-2.0 */
#include "drivers/nor_probe.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t rxbytes[6],sent[6];static unsigned n,reads,cancels;static bool selected,pending,hang,fail;
static void cs(bool x,void *p){(void)p;selected=x;}
static void start(uint8_t x,void *p){(void)p;assert(selected&&!pending&&n<6);sent[n++]=x;pending=true;}
static int poll(uint8_t *x,void *p){(void)p;assert(pending);if(fail)return -1;if(hang)return 0;*x=rxbytes[reads++];pending=false;return 1;}
static void cancel(void *p){(void)p;pending=false;cancels++;}
static nor_probe_io_t io={cs,start,poll,cancel,NULL};
static void reset(uint8_t a,uint8_t b,uint8_t c,uint8_t status){n=reads=cancels=0;selected=pending=hang=fail=false;memset(sent,0,sizeof sent);uint8_t x[]={0,a,b,c,0,status};memcpy(rxbytes,x,sizeof x);}
int main(void){
 for(unsigned cap=0x18;cap<=0x19;cap++){
  reset(0xef,0x40,cap,0);nor_probe_t p={0};assert(nor_probe_begin(&p,&io,100));assert(!nor_probe_begin(&p,&io,100));
  for(uint64_t t=101;p.active;t++){assert(t<120);nor_probe_poll(&p,t);}
  const uint8_t expected[]={0x9f,0xff,0xff,0xff,0x05,0xff};assert(!memcmp(sent,expected,6));assert(n==6&&reads==6&&cancels==1&&!selected);
  assert(p.complete&&p.known&&p.capacity==(cap==0x18?16777216u:33554432u)&&!strcmp(p.reason,"identified"));
 }
 const uint8_t unknown[][3]={{0,0,0},{255,255,255},{0xef,0x40,0x20},{0xc2,0x20,0x19}};
 for(unsigned k=0;k<4;k++){reset(unknown[k][0],unknown[k][1],unknown[k][2],0);nor_probe_t p={0};assert(nor_probe_begin(&p,&io,0));for(unsigned t=1;p.active;t++)nor_probe_poll(&p,t);assert(p.complete&&!p.known&&p.capacity==0&&!strcmp(p.reason,"unknown-jedec"));}
 reset(0xef,0x40,0x19,1);nor_probe_t p={0};assert(nor_probe_begin(&p,&io,0));for(unsigned t=1;p.active;t++)nor_probe_poll(&p,t);assert(!strcmp(p.reason,"flash-busy"));
 reset(0,0,0,0);p=(nor_probe_t){0};assert(nor_probe_begin(&p,&io,100));hang=true;for(unsigned k=0;k<10;k++)nor_probe_poll(&p,200);assert(p.active&&n==1);nor_probe_poll(&p,100100);assert(!p.active&&!selected&&cancels==1&&!p.complete&&!strcmp(p.reason,"timeout"));
 reset(0,0,0,0);p=(nor_probe_t){0};assert(nor_probe_begin(&p,&io,100));nor_probe_poll(&p,99);assert(!p.active&&!selected);
 reset(0,0,0,0);p=(nor_probe_t){0};assert(nor_probe_begin(&p,&io,0));fail=true;nor_probe_poll(&p,1);assert(!p.active&&!strcmp(p.reason,"spi-error")&&cancels==1);
 puts("PASS NOR probe: only 9F/05 transactions, recognized/unknown IDs, exact capacity, busy, timeout/regression/error cleanup; no write commands");
}
