/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "hal/hal.h"
static uint8_t flash[524288],baseline[524288];
static int write_budget=-1,erase_prefix=-1;
static bool read_fail,enabled=true;
static unsigned erases,writes;
bool hal_flash_supported(void){return enabled;}
const char *hal_flash_backend(void){return enabled?"host_sim":"unsupported";}
bool hal_flash_read(uint32_t off,void *dst,size_t n){if(read_fail||off>sizeof(flash)||n>sizeof(flash)-off)return false;memcpy(dst,flash+off,n);return true;}
bool hal_flash_erase_slot(unsigned slot){if(slot>1)return false;erases++;if(erase_prefix>=0){memset(flash+slot*262144,255,(size_t)erase_prefix);return false;}memset(flash+slot*262144,255,262144);return true;}
bool hal_flash_write(uint32_t off,const void *src,size_t n){if(off>sizeof(flash)||n>sizeof(flash)-off)return false;const uint8_t*p=src;for(size_t i=0;i<n;i++){if(write_budget==0)return false;if(write_budget>0)write_budget--;assert((flash[off+i]&p[i])==p[i]);flash[off+i]&=p[i];writes++;}return true;}
#include "../src/drivers/config_store.c"
int main(void){
 uint8_t old[128],next[128],out[128];memset(old,17,128);memset(next,34,128);memset(flash,255,sizeof(flash));
 assert(config_store_load(19,out,128)==CONFIG_STORE_EMPTY);assert(config_store_save(19,old,128)==CONFIG_STORE_OK);assert(config_store_generation()==1);assert(config_store_load(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,old,128));
 unsigned e=erases,w=writes;assert(config_store_save(19,old,128)==CONFIG_STORE_OK);assert(erases==e&&writes==w);memcpy(baseline,flash,sizeof(flash));
 /* Cut every programmed-byte boundary, including the four-byte final seal. */
 for(int cut=0;cut<=164;cut++){
  memcpy(flash,baseline,sizeof(flash));write_budget=cut;
  config_store_result_t result=config_store_save(19,next,128);write_budget=-1;
  assert(config_store_load(19,out,128)==CONFIG_STORE_OK);
  assert(!memcmp(out,old,128)||!memcmp(out,next,128));
  if(result==CONFIG_STORE_OK)assert(!memcmp(out,next,128));
  if(cut<164)assert(!memcmp(out,old,128));
 }
 const int cuts[]={0,1,16,32,104,131072,262144};
 for(unsigned i=0;i<sizeof(cuts)/sizeof(cuts[0]);i++){memcpy(flash,baseline,sizeof(flash));erase_prefix=cuts[i];assert(config_store_save(19,next,128)==CONFIG_STORE_IO_ERROR);erase_prefix=-1;assert(config_store_load(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,old,128));}
 memcpy(flash,baseline,sizeof(flash));assert(config_store_save(19,next,128)==CONFIG_STORE_OK);flash[262144+40]^=1;assert(config_store_load(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,old,128));
 assert(config_store_load(20,out,128)==CONFIG_STORE_INVALID);assert(config_store_save(20,next,128)==CONFIG_STORE_INVALID);assert(config_store_load(19,out,127)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof(flash));wr(flash+4,2);assert(config_store_load(19,out,128)==CONFIG_STORE_INVALID);assert(config_store_save(19,next,128)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof(flash));wr(flash+16,0xffffffffu);wr(flash+20,crc(flash,128));assert(config_store_save(19,next,128)==CONFIG_STORE_OK);assert(config_store_generation()==0);assert(config_store_load(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,next,128));
 read_fail=true;e=erases;assert(config_store_save(19,old,128)==CONFIG_STORE_IO_ERROR);assert(erases==e);read_fail=false;enabled=false;assert(config_store_save(19,old,128)==CONFIG_STORE_UNSUPPORTED);
 puts("PASS two-slot store: 165 byte-cut boundaries, seven torn erases, CRC fallback, future schema/board/length rejection, no-change wear avoidance, generation wrap, read failure");
}
