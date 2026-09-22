/* SPDX-License-Identifier: Apache-2.0
 * Actual recorder -> encoder -> session -> FAT32 -> asynchronous sparse card.
 * Never accesses a block device. All sectors are zero-based. */
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define FAT_SECTORS 16384u
#define DATA_LBA (32u+2u*FAT_SECTORS)
#define CARD_SECTORS 62333952u
#define MAX_STORED 512u
static struct {uint32_t lba;uint8_t data[512];} stored[MAX_STORED];
static unsigned count,delay,reads,writes;static bool pending,writing;
static uint32_t pending_lba;static uint8_t *read_dest;static const uint8_t *write_source;static uint8_t staged[512];
static uint8_t expected[400000],extracted[400000],keep_entry[32],keep_data[512];
static size_t expected_len;static uint64_t now;static bb_session_t session;
static uint32_t get32(const uint8_t *p){return p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static void put16(uint8_t *p,unsigned v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static void put32(uint8_t *p,uint32_t v){put16(p,v);put16(p+2,v>>16);}
static uint8_t *sector(uint32_t lba){assert(lba<CARD_SECTORS);for(unsigned i=0;i<count;i++)if(stored[i].lba==lba)return stored[i].data;assert(count<MAX_STORED);stored[count].lba=lba;return stored[count++].data;}
static bool read_begin(void *ctx,uint32_t lba,uint8_t *out){(void)ctx;assert(!pending&&lba<CARD_SECTORS);pending=true;writing=false;pending_lba=lba;read_dest=out;delay=2;reads++;return true;}
static bool write_begin(void *ctx,uint32_t lba,const uint8_t *src){(void)ctx;assert(!pending&&lba<CARD_SECTORS);pending=true;writing=true;pending_lba=lba;write_source=src;memcpy(staged,src,512);delay=2;writes++;return true;}
static int poll(void *ctx,uint64_t t){(void)ctx;(void)t;assert(pending);if(delay){delay--;return 0;}if(writing){assert(!memcmp(write_source,staged,512));memcpy(sector(pending_lba),staged,512);}else{memset(read_dest,0,512);for(unsigned i=0;i<count;i++)if(stored[i].lba==pending_lba){memcpy(read_dest,stored[i].data,512);break;}}pending=false;return 1;}
static void background(unsigned n){for(unsigned i=0;i<n&&bb_session_busy(&session);i++)bb_session_poll(&session,now);}
static void fixture(void){
 uint8_t *b=sector(0);b[0]=0xeb;b[1]=0x58;b[2]=0x90;memcpy(b+3,"MSWIN4.1",8);put16(b+11,512);b[13]=32;put16(b+14,32);b[16]=2;b[21]=0xf8;put32(b+32,CARD_SECTORS);put32(b+36,FAT_SECTORS);put32(b+44,2);put16(b+48,1);put16(b+50,6);memcpy(b+82,"FAT32   ",8);put16(b+510,0xaa55);memcpy(sector(6),b,512);
 uint8_t *info=sector(1);put32(info,0x41615252);put32(info+484,0x61417272);put32(info+488,0xffffffff);put32(info+492,4);put32(info+508,0xaa550000);memcpy(sector(7),info,512);
 uint8_t *fat=sector(32);put32(fat,0x0ffffff8);put32(fat+4,0x0fffffff);put32(fat+8,0x0fffffff);put32(fat+12,0x0fffffff);memcpy(sector(32+FAT_SECTORS),fat,512);
 uint8_t *root=sector(DATA_LBA);memcpy(root,"KEEP    TXT",11);root[11]=0x20;put16(root+26,3);put32(root+28,9);memcpy(keep_entry,root,32);memcpy(sector(DATA_LBA+32),"Keep me.\n",9);memcpy(keep_data,sector(DATA_LBA+32),512);
}
int main(int argc,char **argv){
 fixture();config_init();pid_init();fatlog_io_t io={NULL,CARD_SECTORS,read_begin,write_begin,poll};blackbox_metadata_t m={500,1000,300,"0.2.0-real-card-fixture",config_get()};
 assert(bb_session_start(&session,&io,&m,now));
 for(unsigned i=0;i<500000&&session.phase!=BBS_RECORDING&&bb_session_busy(&session);i++){now+=10;bb_session_poll(&session,now);}
 if(session.phase!=BBS_RECORDING)fprintf(stderr,"Preparing failed: %s / %s\n",bb_session_name(&session),session.reason);
 assert(session.phase==BBS_RECORDING);uint64_t epoch=now;
 expected_len=blackbox_header((char*)expected,sizeof expected,&m);assert(expected_len);
 float raw[3]={26,-13,4},gyro[3]={25,-12.5f,4},sp[3]={35,-10,5},motor[4]={.2f,.4f,.6f,.8f},rc[4]={.1f,-.05f,.02f,.25f};pid_axis_out_t out;
 for(unsigned j=0;j<1200;j++){
  now+=1000;pid_set_dt(.001f);pid_update(gyro,sp,&out);
  if(j%2==0){pid_trace_t trace;assert(pid_trace_read(&trace));flight_log_sample_t s={.iteration=j,.time_us=(uint32_t)(now-epoch),.dt_us=j?1000:0,.armed=1,.mode=1,.pid_valid=1,.gyro_valid=1,.rx_fresh=1,.output_healthy=1};
   memcpy(s.gyro_raw,raw,sizeof raw);memcpy(s.gyro,gyro,sizeof gyro);memcpy(s.setpoint,sp,sizeof sp);memcpy(s.motor,motor,sizeof motor);memcpy(s.rc,rc,sizeof rc);memcpy(s.p,trace.p,sizeof s.p);memcpy(s.i,trace.i,sizeof s.i);memcpy(s.d,trace.d,sizeof s.d);s.pid_output[0]=out.roll;s.pid_output[1]=out.pitch;s.pid_output[2]=out.yaw;
   size_t n=blackbox_frame(expected+expected_len,sizeof expected-expected_len,&s);assert(n);expected_len+=n;
  }
  bb_capture_observe(now,raw,gyro,sp,&out,motor,rc,true,1,0,true,true,true);background(200);
 }
 bb_session_stop(&session);
 for(unsigned i=0;i<500000&&bb_session_busy(&session);i++){now+=10;bb_session_poll(&session,now);}
 if(session.phase!=BBS_DONE)fprintf(stderr,"Close failed: %s / %s\n",bb_session_name(&session),session.reason);
 assert(session.phase==BBS_DONE&&!pending);expected_len+=blackbox_end(expected+expected_len,sizeof expected-expected_len);
 assert(session.frames==600&&recorder_stats()->total_dropped==0);assert(session.file.bytes_written==expected_len);
 uint8_t *root=sector(DATA_LBA);assert(!memcmp(root,keep_entry,32));assert(!memcmp(sector(DATA_LBA+32),keep_data,512));
 uint8_t *entry=root+32;assert(!memcmp(entry,"BFL00001BBL",11));uint32_t size=get32(entry+28);assert(size==expected_len);
 uint32_t cluster=((uint32_t)(entry[20]|(entry[21]<<8))<<16)|(entry[26]|(entry[27]<<8));size_t pos=0;unsigned clusters=0;
 while(pos<size){assert(cluster>=4&&++clusters<100);for(unsigned j=0;j<32&&pos<size;j++){size_t n=size-pos;if(n>512)n=512;memcpy(extracted+pos,sector(DATA_LBA+(cluster-2)*32+j),n);pos+=n;}uint32_t fat_sector=32+cluster/128;assert(!memcmp(sector(fat_sector),sector(fat_sector+FAT_SECTORS),512));cluster=get32(sector(fat_sector)+(cluster%128)*4)&0x0fffffff;}
 assert(cluster>=0x0ffffff8);assert(clusters==(size+16383u)/16384u);assert(!memcmp(expected,extracted,size));assert(get32(sector(32)+4)&0x08000000);assert(!memcmp(sector(32),sector(32+FAT_SECTORS),512));
 if(argc>1){FILE *f=fopen(argv[1],"wb");assert(f);assert(fwrite(extracted,1,size,f)==size);assert(fclose(f)==0);}
 if(argc>2){FILE *f=fopen(argv[2],"wb");assert(f);uint8_t v[4];put32(v,CARD_SECTORS);assert(fwrite(v,1,4,f)==4);put32(v,count);assert(fwrite(v,1,4,f)==4);for(unsigned k=0;k<count;k++){put32(v,stored[k].lba);assert(fwrite(v,1,4,f)==4);assert(fwrite(stored[k].data,1,512,f)==512);}assert(!fclose(f));}
 printf("PASS real FAT32 end-to-end: 600 PID samples, %u-byte BFL00001.BBL extracted by directory/chain, %u clusters, %u reads/%u writes, delayed transfers, existing file preserved, mirrors match and clean close\n",size,clusters,reads,writes);
}
