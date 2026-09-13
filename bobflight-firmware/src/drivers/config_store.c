/* SPDX-License-Identifier: Apache-2.0
 * Two independent erase slots. Header is LE32 words: magic/schema/board/length/
 * generation/CRC/reserved/legacy-seal. CRC covers first20 bytes, reserved and payload.
 * v2 uses a separate 32-byte commit block after the 128-byte payload; header seal
 * stays erased. This avoids reprogramming an ECC/programming word on future HALs.
 * Seal is programmed LAST, after readback. The previous slot is never erased first.
 */
#include "drivers/config_store.h"
#include "hal/hal.h"
#include <string.h>
#define COMMIT_BYTES 32u
#define RECORD_BYTES (HEADER+MAX_PAYLOAD+COMMIT_BYTES)
#define HEADER 32u
#define MAX_PAYLOAD 128u
#define MAGIC 0x42464346u
#define SEAL 0x51A7C0DEu
static uint32_t generation, loaded_schema;
static uint32_t rd(const uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static void wr(uint8_t*p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
static uint32_t step(uint32_t c,uint8_t b){c^=b;for(unsigned i=0;i<8;i++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);return c;}
static uint32_t crc(const uint8_t*p,size_t n){uint32_t c=~0u;for(unsigned i=0;i<20;i++)c=step(c,p[i]);for(unsigned i=24;i<28;i++)c=step(c,p[i]);for(size_t i=0;i<n;i++)c=step(c,p[HEADER+i]);return ~c;}
static bool record_valid(const uint8_t*p,uint32_t board,size_t n,uint32_t schema){return rd(p)==MAGIC&&rd(p+4)==schema&&rd(p+8)==board&&rd(p+12)==n&&rd(p+24)==0&&(schema==1?rd(p+28)==SEAL:(rd(p+28)==0xffffffffu&&rd(p+HEADER+n)==SEAL))&&rd(p+20)==crc(p,n);}
static bool valid(const uint8_t*p,uint32_t board,size_t n){return record_valid(p,board,n,1);}
static bool acceptable(const uint8_t*p,uint32_t board,size_t n,bool v2){
 return v2 ? record_valid(p,board,128,2)||record_valid(p,board,96,1) : valid(p,board,n);
}
uint32_t config_store_loaded_schema(void){return loaded_schema;}
static bool erased(const uint8_t*p,size_t n){for(size_t i=0;i<n;i++)if(p[i]!=255)return false;return true;}
static bool newer(uint32_t a,uint32_t b){return a!=b&&(uint32_t)(a-b)<0x80000000u;}
static int choose(const uint8_t a[],const uint8_t b[],uint32_t board,size_t n,bool v2){bool x=acceptable(a,board,n,v2),y=acceptable(b,board,n,v2);if(x&&y)return newer(rd(b+16),rd(a+16))?1:0;return x?0:y?1:-1;}
static bool geometry(hal_flash_geometry_t*g){
 if(!hal_flash_supported()||!hal_flash_geometry(g))return false;
 uint32_t u=g->program_unit;
 if(!u||u>COMMIT_BYTES||(u&(u-1u)))return false;
 for(unsigned i=0;i<2;i++)if(g->bytes[i]<RECORD_BYTES||g->offset[i]%u||g->offset[i]>UINT32_MAX-g->bytes[i])return false;
 return g->offset[0]+g->bytes[0]<=g->offset[1]||g->offset[1]+g->bytes[1]<=g->offset[0];
}
bool config_store_supported(void){hal_flash_geometry_t g;return geometry(&g);}
const char *config_store_backend(void){return config_store_supported()?hal_flash_backend():"unsupported";}
uint32_t config_store_generation(void){return generation;}
/* Read only the recognized record length. Unknown headers are retained for the
 * conservative no-overwrite guard; never trust their length as a read bound. */
static bool read_slot(uint32_t offset,uint8_t *p,size_t n,bool v2){
 memset(p,255,RECORD_BYTES);
 if(!hal_flash_read(offset,p,HEADER)){memset(p,255,RECORD_BYTES);return false;}
 size_t tail=0;
 if(rd(p)==MAGIC){
  if(v2&&rd(p+4)==2&&rd(p+12)==128)tail=128+COMMIT_BYTES;
  else if(rd(p+4)==1&&rd(p+12)==(v2?96:n))tail=v2?96:n;
 }
 if(tail&&!hal_flash_read(offset+HEADER,p+HEADER,tail)){memset(p,255,RECORD_BYTES);return false;}
 return true;
}
static config_store_result_t load(uint32_t board,void *payload,size_t n,bool v2){
 generation=loaded_schema=0;if(!payload||!n||n>MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 size_t read_bytes=HEADER+n+(v2?COMMIT_BYTES:0);
 uint8_t a[RECORD_BYTES],b[RECORD_BYTES];
 bool a_ok=read_slot(g.offset[0],a,n,v2),b_ok=read_slot(g.offset[1],b,n,v2);
 int slot=choose(a,b,board,n,v2);if(slot<0)return !a_ok||!b_ok?CONFIG_STORE_IO_ERROR:erased(a,read_bytes)&&erased(b,read_bytes)?CONFIG_STORE_EMPTY:CONFIG_STORE_INVALID;
 const uint8_t *p=slot?b:a;memset(payload,0,n);memcpy(payload,p+HEADER,rd(p+12));generation=rd(p+16);loaded_schema=rd(p+4);return CONFIG_STORE_OK;
}
static config_store_result_t save(uint32_t board,const void *payload,size_t n,bool v2){
 if(!payload||!n||n>MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 size_t read_bytes=HEADER+n+(v2?COMMIT_BYTES:0);
 uint8_t a[RECORD_BYTES],b[RECORD_BYTES],record[RECORD_BYTES],check[RECORD_BYTES];
 if(!read_slot(g.offset[0],a,n,v2)||!read_slot(g.offset[1],b,n,v2))return CONFIG_STORE_IO_ERROR;
 int current=choose(a,b,board,n,v2);const uint8_t *old=current==1?b:a;
 if(current>=0&&rd(old+4)==(v2?2u:1u)&&rd(old+12)==n&&!memcmp(old+HEADER,payload,n)){generation=rd(old+16);return CONFIG_STORE_OK;}
 /* Never overwrite a recognizable future schema/foreign-board record automatically. */
 for(unsigned i=0;i<2;i++){const uint8_t*p=i?b:a;if(rd(p)==MAGIC&&(rd(p+8)!=board || (v2 ? !((rd(p+4)==1&&rd(p+12)==96)||(rd(p+4)==2&&rd(p+12)==128)) : (rd(p+4)!=1||rd(p+12)!=n))))return CONFIG_STORE_INVALID;}
 uint32_t next=current>=0?rd(old+16)+1u:1u;unsigned target=current==0?1u:0u;uint32_t offset=g.offset[target];
 if(!v2&&g.program_unit!=1)return CONFIG_STORE_UNSUPPORTED;
 memset(record,255,sizeof(record));wr(record,MAGIC);wr(record+4,v2?2u:1u);wr(record+8,board);wr(record+12,(uint32_t)n);wr(record+16,next);wr(record+24,0);memcpy(record+HEADER,payload,n);wr(record+20,crc(record,n));
 if(!hal_flash_erase_slot(target)||!hal_flash_write(offset,record,HEADER+n)||!hal_flash_read(offset,check,HEADER+n)||memcmp(record,check,HEADER+n))return CONFIG_STORE_IO_ERROR;
 uint8_t seal[COMMIT_BYTES];memset(seal,255,sizeof(seal));wr(seal,SEAL);
 /* v2 commits in a SEPARATE programming granule: no reprogramming header/ECC word. */
 if(!hal_flash_write(offset+(v2?HEADER+n:28),seal,v2?COMMIT_BYTES:4)||!hal_flash_read(offset,check,read_bytes)||!record_valid(check,board,n,v2?2u:1u)||memcmp(check+HEADER,payload,n))return CONFIG_STORE_IO_ERROR;
 generation=next;return CONFIG_STORE_OK;
}

config_store_result_t config_store_load(uint32_t b,void*p,size_t n){return load(b,p,n,false);}
config_store_result_t config_store_save(uint32_t b,const void*p,size_t n){return save(b,p,n,false);}
config_store_result_t config_store_load_v2(uint32_t b,void*p,size_t n){return n==128?load(b,p,n,true):CONFIG_STORE_INVALID;}
config_store_result_t config_store_save_v2(uint32_t b,const void*p,size_t n){return n==128?save(b,p,n,true):CONFIG_STORE_INVALID;}
