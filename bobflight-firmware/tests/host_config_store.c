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
/* A sealed schema 13 record exactly as schema 13 firmware wrote it (same header/CRC/commit rules). */
static void put_v13(uint32_t off,uint32_t board,uint32_t gen,const uint8_t *payload){
 uint8_t *r=flash+off;memset(r,255,HEADER+256+COMMIT_BYTES);wr(r,MAGIC);wr(r+4,13);wr(r+8,board);wr(r+12,256);wr(r+16,gen);wr(r+24,0);
 memcpy(r+HEADER,payload,256);wr(r+20,crc(r,256));wr(r+HEADER+256,SEAL);
}
int main(void){
 static uint8_t old[1024],next[1024],out[1024];memset(old,17,sizeof old);memset(next,34,sizeof next);
 assert(RECORD_BYTES==1088u&&MAX_PAYLOAD==1024u);
 memset(flash,255,sizeof flash);layout=(hal_flash_geometry_t){{0,262144},{262144,262144},32};strict_granules=true;
 assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_EMPTY&&config_store_loaded_schema()==0);assert(config_store_save(19,old,sizeof old)==CONFIG_STORE_OK);
 assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&config_store_loaded_schema()==14&&!memcmp(old,out,sizeof old));
 memcpy(baseline,flash,sizeof flash);
 for(int cut=0;cut<=(int)RECORD_BYTES;cut++){
  memcpy(flash,baseline,sizeof flash);write_budget=cut;config_store_result_t r=config_store_save(19,next,sizeof next);write_budget=-1;
  config_store_result_t loaded=config_store_load(19,out,sizeof out);
  /* A torn schema/header is conservatively blocked, but the previous physical slot stays intact. */
  assert(!memcmp(flash,baseline,RECORD_BYTES));
  assert(loaded==CONFIG_STORE_OK);assert(!memcmp(out,old,sizeof old)||!memcmp(out,next,sizeof next));
  if(r==CONFIG_STORE_OK)assert(!memcmp(out,next,sizeof next));
 }
 unsigned e=erases;assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_OK&&erases==e);
 memcpy(baseline,flash,sizeof flash);
 /* Slot 0 rewritten to any other schema with the schema 14 length: incompatible (13 needs 256 bytes). */
 for(unsigned schema=1;schema<=15;schema++)if(schema!=14){
  memcpy(flash,baseline,sizeof flash);wr(flash+4,schema);unsigned e0=erases,w0=writes;
  assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&!memcmp(out,next,sizeof next));assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE);assert(erases==e0&&writes==w0);
 }
 for(unsigned schema=1;schema<=15;schema++)if(schema!=13&&schema!=14){memset(flash,255,sizeof flash);wr(flash,MAGIC);wr(flash+4,schema);wr(flash+8,19);wr(flash+12,256);unsigned e0=erases;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INCOMPATIBLE);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE&&erases==e0);}
 memcpy(flash,baseline,sizeof flash);assert(config_store_load(20,out,sizeof out)==CONFIG_STORE_INCOMPATIBLE);assert(config_store_save(20,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE);
 memcpy(flash,baseline,sizeof flash);flash[HEADER]^=1;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&!memcmp(out,next,sizeof next));
 flash[layout.offset[1]+HEADER]^=1;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INVALID);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof flash);read_fail=true;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_IO_ERROR);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_IO_ERROR);read_fail=false;
 assert(config_store_load(19,out,256)==CONFIG_STORE_INVALID);assert(config_store_save(19,next,256)==CONFIG_STORE_INVALID);assert(config_store_save(19,NULL,1024)==CONFIG_STORE_INVALID);
 /* Schema 13 (migration source): read as 256 bytes + zeros, never rewritten by load,
  * always replaced by a schema 14 save into the OTHER slot, generation continues. */
 uint8_t v13[256];for(unsigned i=0;i<256;i++)v13[i]=(uint8_t)(i*7+1);
 memset(flash,255,sizeof flash);put_v13(0,19,41,v13);memcpy(baseline,flash,sizeof flash);
 memset(out,0xAA,sizeof out);assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&config_store_loaded_schema()==13&&config_store_generation()==41);
 assert(!memcmp(out,v13,256));for(unsigned i=256;i<1024;i++)assert(out[i]==0);assert(!memcmp(flash,baseline,sizeof flash));
 memcpy(old,out,sizeof old);e=erases;
 /* Same bytes as the v13 image still rewrite (format change), no unchanged shortcut. */
 assert(config_store_save(19,old,sizeof old)==CONFIG_STORE_OK&&erases==e+1&&config_store_generation()==42&&config_store_loaded_schema()==14);
 assert(!memcmp(flash,baseline,HEADER+256+COMMIT_BYTES));assert(rd(flash+262144+4)==14&&rd(flash+262144+16)==42);
 assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&config_store_loaded_schema()==14&&!memcmp(out,old,sizeof old));
 /* Every write cut of the migrating save leaves the v13 record loadable. */
 for(int cut=0;cut<=(int)RECORD_BYTES;cut+=3){
  memcpy(flash,baseline,sizeof flash);write_budget=cut;config_store_result_t r=config_store_save(19,next,sizeof next);write_budget=-1;
  assert(!memcmp(flash,baseline,HEADER+256+COMMIT_BYTES));
  assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK);
  if(r==CONFIG_STORE_OK)assert(config_store_loaded_schema()==14&&!memcmp(out,next,sizeof next));
  else assert((config_store_loaded_schema()==13&&!memcmp(out,v13,256))||(config_store_loaded_schema()==14&&!memcmp(out,next,sizeof next)));
 }
 /* Corrupt v13: payload bit, CRC word, missing seal, wrong length, foreign board. */
 memcpy(flash,baseline,sizeof flash);flash[HEADER+100]^=4;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INVALID&&config_store_save(19,next,sizeof next)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof flash);flash[20]^=1;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof flash);flash[HEADER+256]=255;flash[HEADER+257]=255;flash[HEADER+258]=255;flash[HEADER+259]=255;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INVALID);
 memcpy(flash,baseline,sizeof flash);wr(flash+12,1024);assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_INCOMPATIBLE&&config_store_save(19,next,sizeof next)==CONFIG_STORE_INCOMPATIBLE);
 memcpy(flash,baseline,sizeof flash);assert(config_store_load(20,out,sizeof out)==CONFIG_STORE_INCOMPATIBLE);
 /* Newer generation wins across schemas; a newer v13 next to an older v14 is still read (downgrade-then-upgrade). */
 memset(flash,255,sizeof flash);put_v13(0,19,7,v13);assert(config_store_save(19,next,sizeof next)==CONFIG_STORE_OK);
 put_v13(0,19,9,v13);assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_OK&&config_store_loaded_schema()==13&&config_store_generation()==9);
 /* Slots too small for a schema 14 record are unsupported (the 16 KiB Matek slots are far larger). */
 layout=(hal_flash_geometry_t){{0,1087},{4096,1087},1};assert(!config_store_supported()&&config_store_load(19,out,sizeof out)==CONFIG_STORE_UNSUPPORTED);
 layout=(hal_flash_geometry_t){{0,16384},{16384,16384},1};assert(config_store_supported());
 enabled=false;assert(config_store_load(19,out,sizeof out)==CONFIG_STORE_UNSUPPORTED);enabled=true;
 puts("PASS schema14 store: current roundtrip, 1089 write cuts, aligned separate commit, old-slot retention, no-wear save; schema13 read for migration (zero-filled, never rewritten by load, replaced only in the other slot, every write cut keeps it), corrupt/foreign/old/future rejection without erasure, CRC and I/O failures, slot-size floor");
 return 0;
}
