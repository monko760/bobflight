/* SPDX-License-Identifier: Apache-2.0
 * Independent adversarial mount checks using the separate end-to-end fixture.
 * Rejection must precede writes, not merely leave a damaged volume dirty. */
#define main existing_card_fixture_test
#include "host_blackbox_card.c"
#undef main
static void reset(void){memset(stored,0,sizeof stored);count=delay=reads=writes=0;pending=writing=false;now=0;fixture();}
int main(void){
 const char *names[]={"mirror mismatch outside reserved status entries","FSInfo targets directory/data region","backup FSInfo targets FAT","root cluster outside volume","FAT too small for cluster count","BPB extends beyond MBR partition","cyclic root chain","invalid backup FSInfo","unsupported FAT version","mismatch in later allocation FAT sector"};
 for(unsigned kind=0;kind<10;kind++){
  reset();uint64_t capacity=CARD_SECTORS;
  if(kind==0)put32(sector(32+FAT_SECTORS)+4*4,0x0fffffff);
  if(kind==1)put16(sector(0)+48,DATA_LBA);
  if(kind==2)put16(sector(0)+50,31);
  if(kind==3)put32(sector(0)+44,CARD_SECTORS/32+100);
  if(kind==4){put32(sector(0)+36,1);memcpy(sector(33),sector(32),512);}
  if(kind==5){for(unsigned n=0;n<count;n++)stored[n].lba+=2048;uint8_t *m=sector(0);m[446]=0x80;m[450]=0x0c;put32(m+454,2048);put32(m+458,1000);put16(m+510,0xaa55);capacity+=2048;}
  if(kind==6){put32(sector(32)+8,3);put32(sector(32)+12,2);memcpy(sector(32+FAT_SECTORS),sector(32),512);}
  if(kind==7)put32(sector(7)+484,0);
  if(kind==8)put16(sector(0)+42,1);
  if(kind==9){put32(sector(1)+492,128);put32(sector(7)+492,128);put32(sector(33+FAT_SECTORS),0x0fffffff);}
  fatlog_t file={0};fatlog_io_t io={NULL,capacity,read_begin,write_begin,poll};
  assert(fatlog_start(&file,&io,now));
  for(unsigned n=0;n<100000&&file.phase!=FATLOG_READY&&file.phase!=FATLOG_ERROR;n++){now+=10;fatlog_poll(&file,now);}
  printf("%s: phase=%u reason=%s writes=%u\n",names[kind],file.phase,file.error?file.error:"none",writes);fflush(stdout);
  assert(file.phase==FATLOG_ERROR&&writes==0);
 }
 puts("PASS ten independent corruption cases refused before any card mutation");
}
