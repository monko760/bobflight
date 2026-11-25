/* SPDX-License-Identifier: Apache-2.0
 * Two independent erase slots. Header is LE32 words: magic/schema/board/length/
 * generation/CRC/reserved/seal-reserved. CRC covers first20 bytes, reserved and payload.
 * The current format uses a separate 32-byte commit block after the payload; header seal
 * stays erased. This avoids reprogramming an ECC/programming word on future HALs.
 * Seal is programmed LAST, after readback. The previous slot is never erased first.
 *
 * Schema 14 (N3) records carry 1024 payload bytes. Schema 13 records (256 bytes,
 * same header/CRC/commit rules) are still read so persist can migrate them; they
 * are never rewritten or erased here. Save always writes schema 14 into the slot
 * that does not hold the current record, so a sealed schema 13 record survives
 * until a second schema 14 save. Any other schema/length/board is incompatible:
 * not migrated, not erased, and save refuses while it exists.
 */
#include "drivers/config_store.h"
#include "hal/hal.h"
#include <string.h>
#define COMMIT_BYTES 32u
#define HEADER 32u
#define MAX_PAYLOAD CONFIG_STORE_PAYLOAD_BYTES
#define RECORD_BYTES (HEADER+MAX_PAYLOAD+COMMIT_BYTES)
#define MAGIC 0x42464346u
#define SEAL 0x51A7C0DEu
_Static_assert(CONFIG_STORE_PAYLOAD_BYTES_V13<CONFIG_STORE_PAYLOAD_BYTES,"schema 14 payload must grow append-only");
_Static_assert(MAX_PAYLOAD%COMMIT_BYTES==0&&CONFIG_STORE_PAYLOAD_BYTES_V13%COMMIT_BYTES==0,"commit block stays program-unit aligned");
static uint32_t generation, loaded_schema;
/* Static scratch: 4 x 1088 bytes would otherwise sit on the CLI stack. Single caller
 * context (CLI/boot, disarmed); not reentrant. */
static uint8_t slot_a[RECORD_BYTES],slot_b[RECORD_BYTES],record[RECORD_BYTES],check[RECORD_BYTES];
static uint32_t rd(const uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static void wr(uint8_t*p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
static uint32_t step(uint32_t c,uint8_t b){c^=b;for(unsigned i=0;i<8;i++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);return c;}
static uint32_t crc(const uint8_t*p,size_t n){uint32_t c=~0u;for(unsigned i=0;i<20;i++)c=step(c,p[i]);for(unsigned i=24;i<28;i++)c=step(c,p[i]);for(size_t i=0;i<n;i++)c=step(c,p[HEADER+i]);return ~c;}
/* Payload length a readable schema carries, or 0 when this store cannot read it. */
static uint32_t schema_len(uint32_t schema){return schema==CONFIG_STORE_SCHEMA?MAX_PAYLOAD:schema==CONFIG_STORE_SCHEMA_V13?CONFIG_STORE_PAYLOAD_BYTES_V13:0u;}
static bool record_valid(const uint8_t*p,uint32_t board){
 uint32_t n=schema_len(rd(p+4));
 return n&&rd(p)==MAGIC&&rd(p+8)==board&&rd(p+12)==n&&rd(p+24)==0&&rd(p+28)==0xffffffffu&&rd(p+HEADER+n)==SEAL&&rd(p+20)==crc(p,n);
}
uint32_t config_store_loaded_schema(void){return loaded_schema;}
static bool erased(const uint8_t*p,size_t n){for(size_t i=0;i<n;i++)if(p[i]!=255)return false;return true;}
static bool newer(uint32_t a,uint32_t b){return a!=b&&(uint32_t)(a-b)<0x80000000u;}
/* Newest valid record of either readable schema (generation is shared, so a
 * migrated schema 14 save is always newer than the schema 13 record it came from). */
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
/* Ours by magic, but a schema/length/board this firmware cannot read. */
static bool incompatible(const uint8_t *p,uint32_t board){uint32_t n=schema_len(rd(p+4));return rd(p)==MAGIC&&(!n||rd(p+8)!=board||rd(p+12)!=n);}
static bool read_slot(uint32_t offset,uint8_t *p){memset(p,255,RECORD_BYTES);return hal_flash_read(offset,p,RECORD_BYTES);}
config_store_result_t config_store_load(uint32_t board,void *payload,size_t n){
 generation=loaded_schema=0;if(!payload||n!=MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 uint8_t *a=slot_a,*b=slot_b;if(!read_slot(g.offset[0],a)||!read_slot(g.offset[1],b))return CONFIG_STORE_IO_ERROR;
 int slot=choose(a,b,board);
 if(slot<0){if(incompatible(a,board)||incompatible(b,board))return CONFIG_STORE_INCOMPATIBLE;return erased(a,RECORD_BYTES)&&erased(b,RECORD_BYTES)?CONFIG_STORE_EMPTY:CONFIG_STORE_INVALID;}
 const uint8_t *p=slot?b:a;uint32_t len=rd(p+12);
 memset(payload,0,n);memcpy(payload,p+HEADER,len);generation=rd(p+16);loaded_schema=rd(p+4);return CONFIG_STORE_OK;
}
config_store_result_t config_store_save(uint32_t board,const void *payload,size_t n){
 if(!payload||n!=MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 hal_flash_geometry_t g;if(!geometry(&g))return CONFIG_STORE_UNSUPPORTED;
 uint8_t *a=slot_a,*b=slot_b;
 if(!read_slot(g.offset[0],a)||!read_slot(g.offset[1],b))return CONFIG_STORE_IO_ERROR;
 if(incompatible(a,board)||incompatible(b,board))return CONFIG_STORE_INCOMPATIBLE;
 int current=choose(a,b,board);const uint8_t *old=current==1?b:a;
 if(current<0&&(!erased(a,RECORD_BYTES)||!erased(b,RECORD_BYTES)))return CONFIG_STORE_INVALID;
 /* Unchanged shortcut only for a current schema 14 record; a schema 13 one is always rewritten. */
 if(current>=0&&rd(old+4)==CONFIG_STORE_SCHEMA&&!memcmp(old+HEADER,payload,n)){generation=rd(old+16);loaded_schema=CONFIG_STORE_SCHEMA;return CONFIG_STORE_OK;}
 uint32_t next=current>=0?rd(old+16)+1u:1u;unsigned target=current==0?1u:0u;uint32_t offset=g.offset[target];
 memset(record,255,RECORD_BYTES);wr(record,MAGIC);wr(record+4,CONFIG_STORE_SCHEMA);wr(record+8,board);wr(record+12,(uint32_t)n);wr(record+16,next);wr(record+24,0);memcpy(record+HEADER,payload,n);wr(record+20,crc(record,n));
 if(!hal_flash_erase_slot(target)||!hal_flash_write(offset,record,HEADER+n)||!hal_flash_read(offset,check,HEADER+n)||memcmp(record,check,HEADER+n))return CONFIG_STORE_IO_ERROR;
 uint8_t seal[COMMIT_BYTES];memset(seal,255,sizeof seal);wr(seal,SEAL);
 if(!hal_flash_write(offset+HEADER+n,seal,sizeof seal)||!hal_flash_read(offset,check,RECORD_BYTES)||!record_valid(check,board)||memcmp(check+HEADER,payload,n))return CONFIG_STORE_IO_ERROR;
 generation=next;loaded_schema=CONFIG_STORE_SCHEMA;return CONFIG_STORE_OK;
}
