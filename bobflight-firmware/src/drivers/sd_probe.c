/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Read-only card/boot-sector probe. No sector-writing calls exist here. */
#include "drivers/sd_probe.h"
#include <string.h>
static uint16_t le16(const uint8_t *v){return (uint16_t)(v[0]|(uint16_t)v[1]<<8);}
static uint32_t le32(const uint8_t *v){return (uint32_t)le16(v)|(uint32_t)le16(v+2)<<16;}
static uint64_t le64(const uint8_t *v){return (uint64_t)le32(v)|(uint64_t)le32(v+4)<<32;}
static bool power2(uint32_t n){return n&&!(n&(n-1u));}
bool sd_probe_busy(const sd_probe_t *p){return p&&(p->phase==SD_PROBE_INIT||p->phase==SD_PROBE_MBR||p->phase==SD_PROBE_BOOT);}
static void error(sd_probe_t *p,const char *why){p->phase=SD_PROBE_ERROR;p->detail=why;}
void sd_probe_cancel(sd_probe_t *p){if(p&&sd_probe_busy(p)){p->phase=SD_PROBE_CANCELLED;p->detail="cancelled";}}
bool sd_probe_start(sd_probe_t *p,const sd_spi_io_t *io,uint64_t now){
 if(!p||!io||sd_probe_busy(p))return false;
 *p=(sd_probe_t){0};p->filesystem="unknown";p->detail="initializing";sd_spi_init_ctx(&p->card,io);
 if(sd_spi_begin_init(&p->card,now)!=SD_SPI_OK){error(p,"init-refused");return false;}
 p->phase=SD_PROBE_INIT;return true;
}
static bool boot(sd_probe_t *p){
 const uint8_t *b=p->sector;
 if(b[510]!=0x55||b[511]!=0xaa)return false;
 uint64_t available=p->partition_lba?p->partition_sectors:p->card.card_info.capacity_sectors;
 if(!memcmp(b+3,"EXFAT   ",8)){
  p->filesystem="exFAT";
  if(b[108]!=9||b[109]>16||(b[110]!=1&&b[110]!=2))return false;
  for(unsigned n=11;n<64;n++)if(b[n])return false;
  uint64_t length=le64(b+72),fat=le32(b+80),fatlen=le32(b+84),heap=le32(b+88),clusters=le32(b+92),root=le32(b+96),spc=1ull<<b[109];
  if(le64(b+64)!=p->partition_lba||!length||length>available||fat<24||!fatlen||heap<fat+fatlen*b[110]||!clusters||root<2||root>=clusters+2||heap+clusters*spc>length||fatlen*512/4<clusters+2)return false;
  p->volume_sectors=length;p->cluster_bytes=(uint32_t)(spc*512);p->volume_flags=le16(b+106);return true;
 }
 if(!memcmp(b+82,"FAT32   ",8)){
  p->filesystem="FAT32";
  uint64_t reserved=le16(b+14),fats=b[16],fatlen=le32(b+36),length=le32(b+32),spc=b[13],root=le32(b+44);
  if(le16(b+11)!=512||!power2((uint32_t)spc)||spc>128||!reserved||(fats!=1&&fats!=2)||!fatlen||le16(b+17)||le16(b+22)||!length||length>available)return false;
  uint64_t overhead=reserved+fats*fatlen;if(overhead>=length)return false;
  uint64_t clusters=(length-overhead)/spc;
  if(clusters<65525||clusters>=0x0ffffff5u||root<2||root>=clusters+2||fatlen*512/4<clusters+2)return false;
  p->volume_sectors=length;p->cluster_bytes=(uint32_t)(spc*512);return true;
 }
 return false;
}
void sd_probe_poll(sd_probe_t *p,uint64_t now){
 if(!sd_probe_busy(p))return;
 sd_spi_status_t st=sd_poll(&p->card,now);
 if(st==SD_SPI_ERR_BUSY)return;
 if(st!=SD_SPI_OK){error(p,"card-io-error");return;}
 if(p->phase==SD_PROBE_INIT){
  if(sd_spi_begin_read(&p->card,0,p->sector,now)!=SD_SPI_OK){error(p,"read-refused");return;}
  p->phase=SD_PROBE_MBR;p->detail="reading-sector-zero";return;
 }
 if(boot(p)){p->phase=SD_PROBE_DONE;p->detail="geometry-recognized-not-mounted";return;}
 if(p->phase==SD_PROBE_BOOT||strcmp(p->filesystem,"unknown")){error(p,"invalid-or-unsupported-volume-geometry");return;}
 if(p->sector[510]!=0x55||p->sector[511]!=0xaa){error(p,"unrecognized-sector-zero");return;}
 unsigned candidates=0;
 for(unsigned i=0;i<4;i++){
  const uint8_t *e=p->sector+446+i*16;uint8_t type=e[4];
  if(type==0xee){error(p,"GPT-not-yet-supported");return;}
  if(type!=0x0b&&type!=0x0c&&type!=0x07)continue;
  uint32_t start=le32(e+8),size=le32(e+12);
  if(!start||!size||(uint64_t)start+size>p->card.card_info.capacity_sectors){error(p,"invalid-partition-bounds");return;}
  candidates++;p->partition_lba=start;p->partition_sectors=size;
 }
 if(candidates!=1){error(p,candidates?"multiple-candidate-partitions":"no-supported-partition");return;}
 if(sd_spi_begin_read(&p->card,p->partition_lba,p->sector,now)!=SD_SPI_OK){error(p,"partition-read-refused");return;}
 p->phase=SD_PROBE_BOOT;p->detail="reading-partition-boot-sector";
}
