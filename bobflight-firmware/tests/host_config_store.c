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
 /* Upgrade either supported old schema; every interrupted write retains an old or new record. */
 for(unsigned schema=1;schema<=2;schema++){
  uint8_t old3[160],new3[160],out3[160];memset(old3,17,sizeof(old3));memset(new3,34,sizeof(new3));
  memset(flash,255,sizeof(flash));layout=(hal_flash_geometry_t){{0,262144},{262144,262144},1};
  assert((schema==1?config_store_save(19,old3,96):config_store_save_v2(19,old3,128))==CONFIG_STORE_OK);
  assert(config_store_load_v3(19,out3,160)==CONFIG_STORE_OK);assert(config_store_loaded_schema()==schema);
  for(unsigned j=schema==1?96:128;j<160;j++)assert(out3[j]==0);
  memcpy(baseline,flash,sizeof(flash));
  for(int cut=0;cut<=224;cut++){
   memcpy(flash,baseline,sizeof(flash));write_budget=cut;
   config_store_result_t r=config_store_save_v3(19,new3,160);write_budget=-1;
   assert(config_store_load_v3(19,out3,160)==CONFIG_STORE_OK);
   if(r==CONFIG_STORE_OK)assert(!memcmp(out3,new3,160)&&config_store_loaded_schema()==3);
   else assert((!memcmp(out3,old3,schema==1?96:128)&&config_store_loaded_schema()==schema)||(!memcmp(out3,new3,160)&&config_store_loaded_schema()==3));
  }
  assert(config_store_save_v2(19,old3,128)==CONFIG_STORE_INVALID);
  unsigned saved_erases=erases;assert(config_store_save_v3(19,new3,160)==CONFIG_STORE_OK&&erases==saved_erases);
 }
 puts("PASS schema1/2 -> schema3 migration, 450 write-cut cases, zero extension, no-wear save, downgrade protection");

 /* Schema3 -> schema4 migration with zero extension and write-cut retention. */
 {
  uint8_t old4[176],new4[176],out4[176];memset(old4,17,160);memset(old4+160,0,16);memset(new4,34,sizeof(new4));
  memset(flash,255,sizeof(flash));layout=(hal_flash_geometry_t){{0,262144},{262144,262144},1};
  assert(config_store_save_v3(19,old4,160)==CONFIG_STORE_OK);
  assert(config_store_load_v4(19,out4,176)==CONFIG_STORE_OK);assert(config_store_loaded_schema()==3);
  for(unsigned j=160;j<176;j++)assert(out4[j]==0);
  memcpy(baseline,flash,sizeof(flash));
  for(int cut=0;cut<=240;cut++){
   memcpy(flash,baseline,sizeof(flash));write_budget=cut;
   config_store_result_t r=config_store_save_v4(19,new4,176);write_budget=-1;
   assert(config_store_load_v4(19,out4,176)==CONFIG_STORE_OK);
   if(r==CONFIG_STORE_OK)assert(!memcmp(out4,new4,176)&&config_store_loaded_schema()==4);
   else assert((!memcmp(out4,old4,160)&&config_store_loaded_schema()==3)||(!memcmp(out4,new4,176)&&config_store_loaded_schema()==4));
  }
  assert(config_store_save_v3(19,old4,160)==CONFIG_STORE_INVALID);
  unsigned saved_erases=erases;assert(config_store_save_v4(19,new4,176)==CONFIG_STORE_OK&&erases==saved_erases);
  puts("PASS schema3 -> schema4 migration, write-cut cases, zero extension, no-wear save, downgrade protection");
 }

 /* Schema4 -> schema5 migration with zero extension and write-cut retention. */
 {
  uint8_t old5[184],new5[184],out5[184];memset(old5,17,176);memset(old5+176,0,8);memset(new5,34,sizeof(new5));
  memset(flash,255,sizeof(flash));layout=(hal_flash_geometry_t){{0,262144},{262144,262144},1};
  assert(config_store_save_v4(19,old5,176)==CONFIG_STORE_OK);
  assert(config_store_load_v5(19,out5,184)==CONFIG_STORE_OK);assert(config_store_loaded_schema()==4);
  for(unsigned j=176;j<184;j++)assert(out5[j]==0);
  memcpy(baseline,flash,sizeof(flash));
  for(int cut=0;cut<=256;cut++){
   memcpy(flash,baseline,sizeof(flash));write_budget=cut;
   config_store_result_t r=config_store_save_v5(19,new5,184);write_budget=-1;
   assert(config_store_load_v5(19,out5,184)==CONFIG_STORE_OK);
   if(r==CONFIG_STORE_OK)assert(!memcmp(out5,new5,184)&&config_store_loaded_schema()==5);
   else assert((!memcmp(out5,old5,176)&&config_store_loaded_schema()==4)||(!memcmp(out5,new5,184)&&config_store_loaded_schema()==5));
  }
  assert(config_store_save_v4(19,old5,176)==CONFIG_STORE_INVALID);
  unsigned saved_erases=erases;assert(config_store_save_v5(19,new5,184)==CONFIG_STORE_OK&&erases==saved_erases);
  puts("PASS schema4 -> schema5 migration, write-cut cases, zero extension, no-wear save, downgrade protection");
 }

 /* Schema5 -> schema6 migration with zero extension and write-cut retention. */
 {
  uint8_t old6[188],new6[188],out6[188];memset(old6,17,184);memset(old6+184,0,4);memset(new6,34,sizeof(new6));
  memset(flash,255,sizeof(flash));layout=(hal_flash_geometry_t){{0,262144},{262144,262144},1};
  assert(config_store_save_v5(19,old6,184)==CONFIG_STORE_OK);
  assert(config_store_load_v6(19,out6,188)==CONFIG_STORE_OK);assert(config_store_loaded_schema()==5);
  for(unsigned j=184;j<188;j++)assert(out6[j]==0);
  memcpy(baseline,flash,sizeof(flash));
  for(int cut=0;cut<=256;cut++){
   memcpy(flash,baseline,sizeof(flash));write_budget=cut;
   config_store_result_t r=config_store_save_v6(19,new6,188);write_budget=-1;
   assert(config_store_load_v6(19,out6,188)==CONFIG_STORE_OK);
   if(r==CONFIG_STORE_OK)assert(!memcmp(out6,new6,188)&&config_store_loaded_schema()==6);
   else assert((!memcmp(out6,old6,184)&&config_store_loaded_schema()==5)||(!memcmp(out6,new6,188)&&config_store_loaded_schema()==6));
  }
  assert(config_store_save_v5(19,old6,184)==CONFIG_STORE_INVALID);
  unsigned saved_erases=erases;assert(config_store_save_v6(19,new6,188)==CONFIG_STORE_OK&&erases==saved_erases);
  puts("PASS schema5 -> schema6 migration, write-cut cases, zero extension, no-wear save, downgrade protection");
 }




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

 enabled=true;read_fail=false;write_budget=-1;erase_prefix=-1;
 memset(flash,255,sizeof(flash));
 assert(config_store_save(19,old,96)==CONFIG_STORE_OK);
 assert(config_store_load_v2(19,out,128)==CONFIG_STORE_OK);
 assert(config_store_loaded_schema()==1&&!memcmp(out,old,96));
 for(unsigned i=96;i<128;i++)assert(out[i]==0);
 uint8_t legacy[128];memcpy(legacy,out,128);memcpy(baseline,flash,sizeof(flash));
 for(int cut=0;cut<=192;cut++){
  memcpy(flash,baseline,sizeof(flash));write_budget=cut;
  config_store_result_t result=config_store_save_v2(19,next,128);write_budget=-1;
  assert(!memcmp(flash,baseline,262144)); /* legacy slot NEVER erased first */
  assert(config_store_load_v2(19,out,128)==CONFIG_STORE_OK);
  if(result==CONFIG_STORE_OK){assert(!memcmp(out,next,128));assert(config_store_loaded_schema()==2);}
  else {assert(!memcmp(out,legacy,128)||!memcmp(out,next,128));if(cut<164)assert(!memcmp(out,legacy,128));}
 }
 for(unsigned i=0;i<sizeof(cuts)/sizeof(cuts[0]);i++){
  memcpy(flash,baseline,sizeof(flash));erase_prefix=cuts[i];assert(config_store_save_v2(19,next,128)==CONFIG_STORE_IO_ERROR);erase_prefix=-1;
  assert(config_store_load_v2(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,legacy,128));
 }
 memcpy(flash,baseline,sizeof(flash));assert(config_store_save_v2(19,next,128)==CONFIG_STORE_OK);
 e=erases;w=writes;assert(config_store_save_v2(19,next,128)==CONFIG_STORE_OK&&e==erases&&w==writes);
 flash[262144+140]^=1;assert(config_store_load_v2(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,legacy,128));
 memcpy(flash,baseline,sizeof(flash));wr(flash+4,3);e=erases;assert(config_store_save_v2(19,next,128)==CONFIG_STORE_INVALID&&e==erases);
 memcpy(flash,baseline,sizeof(flash));assert(config_store_save_v2(20,next,128)==CONFIG_STORE_INVALID);
 assert(config_store_save_v2(19,next,127)==CONFIG_STORE_INVALID);
 enabled=false;e=erases;assert(config_store_save_v2(19,next,128)==CONFIG_STORE_UNSUPPORTED&&e==erases);

 enabled=true;strict_granules=true;
 for(unsigned unit=1;unit<=32;unit*=2){
  layout=(hal_flash_geometry_t){{4096,65536},{16384,32768},unit};memset(flash,255,sizeof(flash));
  assert(config_store_save_v2(19,old,128)==CONFIG_STORE_OK);
  assert(config_store_save_v2(19,next,128)==CONFIG_STORE_OK);
  assert(config_store_load_v2(19,out,128)==CONFIG_STORE_OK&&!memcmp(out,next,128));
 }
 strict_granules=false;
 for(unsigned fault=0;fault<5;fault++){
  layout=(hal_flash_geometry_t){{0,262144},{262144,262144},1};
  if(fault==0)layout.program_unit=64;
  if(fault==1)layout.offset[1]=16;
  if(fault==2)layout.bytes[0]=128;
  if(fault==3)layout.offset[1]=UINT32_MAX-16;
  if(fault==4)layout.program_unit=3;
  e=erases;assert(config_store_save_v2(19,next,128)==CONFIG_STORE_UNSUPPORTED&&e==erases);
 }
 puts("PASS variable backend geometry, 1/2/4/8/16/32-byte one-program-per-granule writes, overlap/size/overflow/alignment-capability guards");
 puts("PASS schema1 -> schema2 migration: all 193 v2 program cuts, seven torn erases, preserved legacy slot, CRC fallback, no-wear repeated save, future/foreign/length refusal");
 puts("PASS two-slot store: 165 byte-cut boundaries, seven torn erases, CRC fallback, future schema/board/length rejection, no-change wear avoidance, generation wrap, read failure");
}
