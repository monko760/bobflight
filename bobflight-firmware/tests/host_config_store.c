/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "hal/hal.h"
static uint8_t flash[524288],baseline[524288];
static int write_budget=-1,erase_prefix=-1;
static bool read_fail,enabled=true;
static unsigned erases,writes;
static hal_flash_geometry_t layout={{0,262144},{262144,262144},1};
static bool strict_granules;
bool hal_flash_geometry(hal_flash_geometry_t*g){*g=layout;return true;}
bool hal_flash_supported(void){return enabled;}
const char *hal_flash_backend(void){return enabled?"host_sim":"unsupported";}
bool hal_flash_read(uint32_t off,void *dst,size_t n){if(read_fail||off>sizeof(flash)||n>sizeof(flash)-off)return false;memcpy(dst,flash+off,n);return true;}
bool hal_flash_erase_slot(unsigned slot){if(slot>1)return false;erases++;if(erase_prefix>=0){memset(flash+layout.offset[slot],255,(size_t)erase_prefix);return false;}memset(flash+layout.offset[slot],255,layout.bytes[slot]);return true;}
bool hal_flash_write(uint32_t off,const void *src,size_t n){if(off>sizeof(flash)||n>sizeof(flash)-off)return false;const uint8_t*p=src;
 if(strict_granules){assert(off%layout.program_unit==0&&n%layout.program_unit==0);for(size_t i=0;i<n;i++)assert(flash[off+i]==255);}
 for(size_t i=0;i<n;i++){if(write_budget==0)return false;if(write_budget>0)write_budget--;assert((flash[off+i]&p[i])==p[i]);flash[off+i]&=p[i];writes++;}return true;}
#include "../src/drivers/config_store.c"
int main(void){
 uint8_t old[256],next[256],out[256];memset(old,17,sizeof old);memset(next,34,sizeof next);
 memset(flash,255,sizeof flash);layout=(hal_flash_geometry_t){{0,262144},{262144,262144},32};strict_granules=true;
 assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_EMPTY);assert(config_store_save(19,old,sizeof old)==CONFIG_STORE_OK);
 assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&config_store_loaded_schema()==13&&!memcmp(old,out,sizeof old));
 memcpy(baseline,flash,sizeof flash);
 for(int cut=0;cut<=320;cut++){
  memcpy(flash,baseline,sizeof flash);write_budget=cut;config_store_result_t r=config_store_save(19,next,sizeof next);write_budget=-1;
  config_store_result_t loaded=config_store_load(19,out,sizeof out);
  /* A torn schema/header is conservatively blocked, but the previous physical slot stays intact. */
  assert(!memcmp(flash,baseline,RECORD_BYTES));
  assert(loaded==CONFIG_STORE_OK);assert(!memcmp(out,old,sizeof old)||!memcmp(out,next,sizeof next));
  if(r==CONFIG_STORE_OK)assert(!memcmp(out,next,sizeof next));
 }
 unsigned e=erases;assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_OK&&erases==e);
 memcpy(baseline,flash,sizeof flash);
 for(unsigned schema=1;schema<=14;schema++)if(schema!=13){
  memcpy(flash,baseline,sizeof flash);wr(flash+4,schema);unsigned e0=erases,w0=writes;
  assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&!memcmp(out,next,sizeof next));assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE);assert(erases==e0&&writes==w0);
 }
 for(unsigned schema=1;schema<=14;schema++)if(schema!=13){memset(flash,255,sizeof flash);wr(flash,MAGIC);wr(flash+4,schema);wr(flash+8,19);wr(flash+12,256);unsigned e0=erases;assert(config_store_load(19,out,256)==CONFIG_STORE_INCOMPATIBLE);assert(config_store_save(19,next,256)==CONFIG_STORE_INCOMPATIBLE&&erases==e0);}
 memcpy(flash,baseline,sizeof flash);assert(config_store_load(20,out,sizeof out)==CONFIG_STORE_INCOMPATIBLE);assert(config_store_save(20,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE);
 memcpy(flash,baseline,sizeof flash);flash[HEADER]^=1;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&!memcmp(out,next,sizeof next));
 flash[layout.offset[1]+HEADER]^=1;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INVALID);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof flash);read_fail=true;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_IO_ERROR);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_IO_ERROR);read_fail=false;
 assert(config_store_load(19,out,255)==CONFIG_STORE_INVALID);assert(config_store_save(19,NULL,256)==CONFIG_STORE_INVALID);
 enabled=false;assert(config_store_load(19,out,256)==CONFIG_STORE_UNSUPPORTED);enabled=true;
 puts("PASS schema13 only: current roundtrip, 321 write cuts, aligned separate commit, old-slot retention, no-wear save, old/future/foreign rejection without erasure, CRC and I/O failures");
 return 0;
}
