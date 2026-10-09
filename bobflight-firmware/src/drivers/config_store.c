/* SPDX-License-Identifier: Apache-2.0
 * Two independent erase slots. Header is LE32 words: magic/schema/board/length/
 * generation/CRC/reserved/seal-reserved. CRC covers first20 bytes, reserved and payload.
 * The current format uses a separate 32-byte commit block after the payload; header seal
 * stays erased. This avoids reprogramming an ECC/programming word on future HALs.
 * Seal is programmed LAST, after readback. The previous slot is never erased first.
 */
#include "drivers/config_store.h"
#include "hal/hal.h"
#include <string.h>
#define COMMIT_BYTES 32u
#define RECORD_BYTES (HEADER+MAX_PAYLOAD+COMMIT_BYTES)
#define HEADER 32u
#define MAX_PAYLOAD CONFIG_STORE_PAYLOAD_BYTES
#define MAGIC 0x42464346u
#define SEAL 0x51A7C0DEu
static uint32_t generation, loaded_schema;
static uint32_t rd(const uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static void wr(uint8_t*p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
static uint32_t step(uint32_t c,uint8_t b){c^=b;for(unsigned i=0;i<8;i++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);return c;}
static uint32_t crc(const uint8_t*p,size_t n){uint32_t c=~0u;for(unsigned i=0;i<20;i++)c=step(c,p[i]);for(unsigned i=24;i<28;i++)c=step(c,p[i]);for(size_t i=0;i<n;i++)c=step(c,p[HEADER+i]);return ~c;}
static bool record_valid(const uint8_t*p,uint32_t board){return rd(p)==MAGIC&&rd(p+4)==CONFIG_STORE_SCHEMA&&rd(p+8)==board&&rd(p+12)==MAX_PAYLOAD&&rd(p+24)==0&&rd(p+28)==0xffffffffu&&rd(p+HEADER+MAX_PAYLOAD)==SEAL&&rd(p+20)==crc(p,MAX_PAYLOAD);}
uint32_t config_store_loaded_schema(void){return loaded_schema;}
static bool erased(const uint8_t*p,size_t n){for(size_t i=0;i<n;i++)if(p[i]!=255)return false;return true;}
static bool newer(uint32_t a,uint32_t b){return a!=b&&(uint32_t)(a-b)<0x80000000u;}
static int choose(const uint8_t a[],const uint8_t b[],uint32_t board){bool x=record_valid(a,board),y=record_valid(b,board);if(x&&y)return newer(rd(b+16),rd(a+16))?1:0;return x?0:y?1:-1;}
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
/* Only schema13 is accepted. Old/future/foreign records are not migrated or erased. */
static bool incompatible(const uint8_t *p,uint32_t board){return rd(p)==MAGIC&&(rd(p+4)!=CONFIG_STORE_SCHEMA||rd(p+8)!=board||rd(p+12)!=MAX_PAYLOAD);}
static bool read_slot(uint32_t offset,uint8_t *p){memset(p,255,RECORD_BYTES);return hal_flash_read(offset,p,RECORD_BYTES);}
config_store_result_t config_store_load(uint32_t board,void *payload,size_t n){
 generation=loaded_schema=0;if(!payload||n!=MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 uint8_t a[RECORD_BYTES],b[RECORD_BYTES];if(!read_slot(g.offset[0],a)||!read_slot(g.offset[1],b))return CONFIG_STORE_IO_ERROR;
 int slot=choose(a,b,board);
 if(slot<0){if(incompatible(a,board)||incompatible(b,board))return CONFIG_STORE_INCOMPATIBLE;return erased(a,RECORD_BYTES)&&erased(b,RECORD_BYTES)?CONFIG_STORE_EMPTY:CONFIG_STORE_INVALID;}
 const uint8_t *p=slot?b:a;memcpy(payload,p+HEADER,n);generation=rd(p+16);loaded_schema=CONFIG_STORE_SCHEMA;return CONFIG_STORE_OK;
}
config_store_result_t config_store_save(uint32_t board,const void *payload,size_t n){
 if(!payload||n!=MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 uint8_t a[RECORD_BYTES],b[RECORD_BYTES],record[RECORD_BYTES],check[RECORD_BYTES];
 if(!read_slot(g.offset[0],a)||!read_slot(g.offset[1],b))return CONFIG_STORE_IO_ERROR;
 if(incompatible(a,board)||incompatible(b,board))return CONFIG_STORE_INCOMPATIBLE;
 int current=choose(a,b,board);const uint8_t *old=current==1?b:a;
 if(current<0&&(!erased(a,RECORD_BYTES)||!erased(b,RECORD_BYTES)))return CONFIG_STORE_INVALID;
 if(current>=0&&!memcmp(old+HEADER,payload,n)){generation=rd(old+16);return CONFIG_STORE_OK;}
 uint32_t next=current>=0?rd(old+16)+1u:1u;unsigned target=current==0?1u:0u;uint32_t offset=g.offset[target];
 memset(record,255,sizeof record);wr(record,MAGIC);wr(record+4,CONFIG_STORE_SCHEMA);wr(record+8,board);wr(record+12,(uint32_t)n);wr(record+16,next);wr(record+24,0);memcpy(record+HEADER,payload,n);wr(record+20,crc(record,n));
 if(!hal_flash_erase_slot(target)||!hal_flash_write(offset,record,HEADER+n)||!hal_flash_read(offset,check,HEADER+n)||memcmp(record,check,HEADER+n))return CONFIG_STORE_IO_ERROR;
 uint8_t seal[COMMIT_BYTES];memset(seal,255,sizeof seal);wr(seal,SEAL);
 if(!hal_flash_write(offset+HEADER+n,seal,sizeof seal)||!hal_flash_read(offset,check,sizeof check)||!record_valid(check,board)||memcmp(check+HEADER,payload,n))return CONFIG_STORE_IO_ERROR;
 generation=next;return CONFIG_STORE_OK;
}
