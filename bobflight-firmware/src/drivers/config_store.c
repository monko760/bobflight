/* SPDX-License-Identifier: Apache-2.0
 * Two independent erase slots. Header is LE32 words: magic/schema/board/length/
 * generation/CRC/reserved/seal. CRC covers first 20 bytes, reserved and payload.
 * Seal is programmed LAST, after readback. The previous slot is never erased first.
 */
#include "drivers/config_store.h"
#include "hal/hal.h"
#include <string.h>
#define SLOT_BYTES (256u*1024u)
#define HEADER 32u
#define MAX_PAYLOAD 128u
#define MAGIC 0x42464346u
#define SEAL 0x51A7C0DEu
static uint32_t generation;
static uint32_t rd(const uint8_t*p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static void wr(uint8_t*p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
static uint32_t step(uint32_t c,uint8_t b){c^=b;for(unsigned i=0;i<8;i++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);return c;}
static uint32_t crc(const uint8_t*p,size_t n){uint32_t c=~0u;for(unsigned i=0;i<20;i++)c=step(c,p[i]);for(unsigned i=24;i<28;i++)c=step(c,p[i]);for(size_t i=0;i<n;i++)c=step(c,p[HEADER+i]);return ~c;}
static bool valid(const uint8_t*p,uint32_t board,size_t n){return rd(p)==MAGIC&&rd(p+4)==1&&rd(p+8)==board&&rd(p+12)==n&&rd(p+24)==0&&rd(p+28)==SEAL&&rd(p+20)==crc(p,n);}
static bool erased(const uint8_t*p,size_t n){for(size_t i=0;i<n;i++)if(p[i]!=255)return false;return true;}
static bool newer(uint32_t a,uint32_t b){return a!=b&&(uint32_t)(a-b)<0x80000000u;}
static int choose(const uint8_t a[],const uint8_t b[],uint32_t board,size_t n){bool x=valid(a,board,n),y=valid(b,board,n);if(x&&y)return newer(rd(b+16),rd(a+16))?1:0;return x?0:y?1:-1;}
bool config_store_supported(void){return hal_flash_supported();}
const char *config_store_backend(void){return hal_flash_backend();}
uint32_t config_store_generation(void){return generation;}
config_store_result_t config_store_load(uint32_t board,void *payload,size_t n){
 generation=0;if(!payload||!n||n>MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 if(!config_store_supported())return CONFIG_STORE_UNSUPPORTED;
 uint8_t a[HEADER+MAX_PAYLOAD],b[HEADER+MAX_PAYLOAD];
 if(!hal_flash_read(0,a,HEADER+n)||!hal_flash_read(SLOT_BYTES,b,HEADER+n))return CONFIG_STORE_IO_ERROR;
 int slot=choose(a,b,board,n);if(slot<0)return erased(a,HEADER+n)&&erased(b,HEADER+n)?CONFIG_STORE_EMPTY:CONFIG_STORE_INVALID;
 const uint8_t *p=slot?b:a;memcpy(payload,p+HEADER,n);generation=rd(p+16);return CONFIG_STORE_OK;
}
config_store_result_t config_store_save(uint32_t board,const void *payload,size_t n){
 if(!payload||!n||n>MAX_PAYLOAD)return CONFIG_STORE_INVALID;
 if(!config_store_supported())return CONFIG_STORE_UNSUPPORTED;
 uint8_t a[HEADER+MAX_PAYLOAD],b[HEADER+MAX_PAYLOAD],record[HEADER+MAX_PAYLOAD],check[HEADER+MAX_PAYLOAD];
 if(!hal_flash_read(0,a,HEADER+n)||!hal_flash_read(SLOT_BYTES,b,HEADER+n))return CONFIG_STORE_IO_ERROR;
 int current=choose(a,b,board,n);const uint8_t *old=current==1?b:a;
 if(current>=0&&!memcmp(old+HEADER,payload,n)){generation=rd(old+16);return CONFIG_STORE_OK;}
 /* Never overwrite a recognizable future schema/foreign-board record automatically. */
 for(unsigned i=0;i<2;i++){const uint8_t*p=i?b:a;if(rd(p)==MAGIC&&(rd(p+4)!=1||rd(p+8)!=board||rd(p+12)!=n))return CONFIG_STORE_INVALID;}
 uint32_t next=current>=0?rd(old+16)+1u:1u;unsigned target=current==0?1u:0u;uint32_t offset=target*SLOT_BYTES;
 memset(record,255,sizeof(record));wr(record,MAGIC);wr(record+4,1);wr(record+8,board);wr(record+12,(uint32_t)n);wr(record+16,next);wr(record+24,0);memcpy(record+HEADER,payload,n);wr(record+20,crc(record,n));
 if(!hal_flash_erase_slot(target)||!hal_flash_write(offset,record,HEADER+n)||!hal_flash_read(offset,check,HEADER+n)||memcmp(record,check,HEADER+n))return CONFIG_STORE_IO_ERROR;
 uint8_t seal[4];wr(seal,SEAL);
 if(!hal_flash_write(offset+28,seal,4)||!hal_flash_read(offset,check,HEADER+n)||!valid(check,board,n)||memcmp(check+HEADER,payload,n))return CONFIG_STORE_IO_ERROR;
 generation=next;return CONFIG_STORE_OK;
}
