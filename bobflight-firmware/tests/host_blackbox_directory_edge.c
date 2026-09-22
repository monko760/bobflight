/* SPDX-License-Identifier: Apache-2.0
 * Exact zero-based directory-sector boundary cases. No physical card access. */
#define main original_card_pipeline
#include "host_blackbox_card.c"
#undef main
static void init_fixture(void){memset(stored,0,sizeof stored);count=reads=writes=delay=0;pending=writing=false;now=0;fixture();}
static void await_ready(fatlog_t *f){for(unsigned i=0;i<100000&&f->phase!=FATLOG_READY&&f->phase!=FATLOG_DONE&&f->phase!=FATLOG_ERROR;i++){now+=10;fatlog_poll(f,now);}assert(f->phase==FATLOG_READY||f->phase==FATLOG_DONE);}
int main(void){
 for(unsigned last_sector=0;last_sector<=31;last_sector+=31){
  init_fixture();unsigned last_entry=last_sector*16+15;
  for(unsigned k=1;k<last_entry;k++){uint8_t *e=sector(DATA_LBA+k/16)+(k%16)*32;char name[12];snprintf(name,sizeof name,"E%07uTXT",k);memcpy(e,name,11);e[11]=0x20;}
  uint8_t *adjacent=sector(DATA_LBA+last_sector+1),snapshot[512];
  if(!last_sector)memset(adjacent,0xA5,512);memcpy(snapshot,adjacent,512);
  fatlog_t file;fatlog_io_t io={NULL,CARD_SECTORS,read_begin,write_begin,poll};assert(fatlog_start(&file,&io,now));await_ready(&file);
  uint8_t data[512]={42};assert(fatlog_write(&file,data,1,now));await_ready(&file);assert(fatlog_close(&file,now));await_ready(&file);assert(file.phase==FATLOG_DONE);
  const uint8_t *e=sector(DATA_LBA+last_sector)+15*32;assert(!memcmp(e,"BFL00001BBL",11)&&get32(e+28)==1);
  assert(!memcmp(sector(DATA_LBA),keep_entry,32));
  if(last_sector)assert(!memcmp(adjacent,snapshot,512)); /* Adjacent cluster belongs to KEEP.TXT. */
  else {for(unsigned n=0;n<32;n++)assert(!adjacent[n]);assert(!memcmp(adjacent+32,snapshot+32,480));}
 }
 puts("PASS root end-marker at sector edge preserves following bytes; root-cluster edge never overwrites adjacent existing-file cluster");
}
