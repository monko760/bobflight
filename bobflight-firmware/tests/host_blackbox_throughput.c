/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Blackbox SD writer throughput model. Drives the REAL production writer path
 * (blackbox_cli.h poll/status -> session -> encoder -> FAT32 -> sd_spi byte
 * state machine) against a byte-level SPI-mode SD card emulator on a virtual
 * clock: 13.5 MHz SPI bytes, per-call CPU cost, card read latency, per-sector
 * write busy time and periodic multi-ms stalls. A table of loop configurations
 * (1000/1, 8000/2, 8000/1) with separate gyro-only and PID slot costs captures
 * through the schema 3 bb_capture_observe_ex path (decimate first); the
 * background blackbox poll runs between slots like main.c + scheduler_run.
 * The requested rate is the build's BLACKBOX_RATE_DEFAULT_HZ (500 by default;
 * a second CTest target builds this file with 1000u).
 * Model parameters are assumptions, not physical measurements.
 * Never accesses a block device. */
#include "flight/arming.h"
#include "sched/tasks.h"
#include "sched/scheduler.h"
#include "board/board.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/sd_spi.h"
#include "flight/config.h"
#include "flight/pid.h"
#include "hal/hal.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------- virtual clock ---------------- */
static uint64_t vt_ns;
#define CLOCK_READ_NS 40u     /* hal_micros() cost (DWT fold, IRQ mask) */
#define POLL_CALL_NS 150u     /* one sd_poll + exchange-poll callback */
#define FAST_BYTE_NS 593u     /* 8 bits at 13.5 MHz (108 MHz PCLK2 / 8) */
#define SLOW_BYTE_NS 48000u   /* GPIO-clocked init, 3 us half period */
uint64_t hal_micros(void){vt_ns+=CLOCK_READ_NS;return vt_ns/1000u;}

/* ---------------- CLI stubs (as host_blackbox_cli.c) ---------------- */
static bool bl_pending;
static char output[4096];
static void cli_write_str(const char *s){size_t n=strlen(output);if(n+strlen(s)>=sizeof output)output[0]=0;strcat(output,s);}
arm_state_t arming_state(void){return ARM_DISARMED;}
bool bench_motor_active(void){return false;}
bool gyro_manual_calibration_active(void){return false;}
bool hal_usb_cdc_connected(void){return true;}
bool persist_dirty(void){return false;}
unsigned dshot_speed_kbps(void){return 300;}
static scheduler_stats_t model_sched={.gyro_hz=1000,.pid_process_denom=1};
const scheduler_stats_t *scheduler_stats(void){return &model_sched;}
const board_t *board_get(void){static board_t b={.board_id="bbtest"};return &b;}
static uint64_t next_gyro_us;
/* Same contract/constants as the production scheduler_bg_budget_us (unit
 * tested in host_scheduler_timing.c), evaluated against this model's deadline. */
uint32_t scheduler_bg_budget_us(uint64_t now){
 if(now>=next_gyro_us)return 0;uint64_t left=next_gyro_us-now;
 if(left<=SCHEDULER_BG_GUARD_US)return 0;left-=SCHEDULER_BG_GUARD_US;
 return left>SCHEDULER_BG_MAX_US?SCHEDULER_BG_MAX_US:(uint32_t)left;
}

/* ---------------- sparse sector store ---------------- */
#define STORE_SLOTS 32768u
static struct {uint32_t lba;bool used;uint8_t data[512];} store[STORE_SLOTS];
static unsigned stored;
static uint8_t *sector_at(uint32_t lba,bool create){
 uint32_t h=(lba*2654435761u)%STORE_SLOTS;
 for(unsigned i=0;i<STORE_SLOTS;i++){unsigned k=(h+i)%STORE_SLOTS;
  if(store[k].used&&store[k].lba==lba)return store[k].data;
  if(!store[k].used){if(!create)return NULL;assert(stored<STORE_SLOTS*3u/4u);store[k].used=true;store[k].lba=lba;stored++;memset(store[k].data,0,512);return store[k].data;}
 }
 abort();
}

/* ---------------- byte-level SPI SD card emulator ---------------- */
typedef struct {
 const char *name;
 uint32_t write_busy_us;   /* programming time after each accepted block */
 uint32_t read_latency_us; /* CMD17 access time before the data token */
 uint32_t stall_every;     /* every Nth write gets an extra stall (0 = never) */
 uint32_t stall_us;
} card_model_t;
static card_model_t card;
enum {C_CMD,C_WR_TOKEN,C_WR_DATA,C_WR_RESP,C_WR_BUSY,C_RD_WAIT};
static struct {
 bool cs,slow,pending,app;uint8_t rx;uint64_t done_ns;
 int mode;uint8_t cmd[6];unsigned cmd_n;
 uint8_t out[600];unsigned out_head,out_tail;
 uint8_t wbuf[514];unsigned wn;uint32_t wlba,rlba;uint64_t busy_until_ns,token_ns;
 uint64_t writes,reads,busy_ns_total;
} sd;
#define FAT_SECTORS 16384u
#define DATA_LBA (32u+2u*FAT_SECTORS)
#define CARD_SECTORS 62333952u /* C_SIZE 60872 */
static void out_push(uint8_t b){assert(sd.out_tail<sizeof sd.out);sd.out[sd.out_tail++]=b;}
static void sd_command(void){
 unsigned idx=sd.cmd[0]&63u;uint32_t arg=((uint32_t)sd.cmd[1]<<24)|((uint32_t)sd.cmd[2]<<16)|((uint32_t)sd.cmd[3]<<8)|sd.cmd[4];
 assert(((sd_crc7(sd.cmd,5)<<1)|1)==sd.cmd[5]);
 sd.out_head=sd.out_tail=0;out_push(0xFF);
 bool app=sd.app;sd.app=false;
 if(idx==0)out_push(0x01);
 else if(idx==8){out_push(0x01);out_push(0);out_push(0);out_push(0x01);out_push(0xAA);}
 else if(idx==55){out_push(0x01);sd.app=true;}
 else if(idx==41&&app)out_push(0x00);
 else if(idx==58){out_push(0);out_push(0xC0);out_push(0xFF);out_push(0x80);out_push(0);}
 else if(idx==9){uint8_t csd[16]={0};csd[0]=0x40;csd[7]=0x00;csd[8]=0xED;csd[9]=0xC8;out_push(0);out_push(0xFE);for(unsigned i=0;i<16;i++)out_push(csd[i]);uint16_t c=sd_crc16(csd,16);out_push((uint8_t)(c>>8));out_push((uint8_t)c);}
 else if(idx==17){assert(arg<CARD_SECTORS);out_push(0);sd.rlba=arg;sd.mode=C_RD_WAIT;sd.token_ns=vt_ns+(uint64_t)card.read_latency_us*1000u;sd.reads++;}
 else if(idx==24){assert(arg<CARD_SECTORS);out_push(0);sd.wlba=arg;sd.mode=C_WR_TOKEN;sd.wn=0;}
 else out_push(0x04);
}
static uint8_t sd_byte(uint8_t tx){
 if(!sd.cs)return 0xFF;
 switch(sd.mode){
 case C_WR_TOKEN:
  if(sd.out_head<sd.out_tail)return sd.out[sd.out_head++]; /* R1 drains first */
  if(tx==0xFE){sd.mode=C_WR_DATA;sd.wn=0;}
  return 0xFF;
 case C_WR_DATA:
  sd.wbuf[sd.wn++]=tx;
  if(sd.wn==514){assert(((uint16_t)sd.wbuf[512]<<8|sd.wbuf[513])==sd_crc16(sd.wbuf,512));memcpy(sector_at(sd.wlba,true),sd.wbuf,512);sd.mode=C_WR_RESP;}
  return 0xFF;
 case C_WR_RESP:{
  sd.writes++;uint64_t busy=(uint64_t)card.write_busy_us*1000u;
  if(card.stall_every&&sd.writes%card.stall_every==0)busy+=(uint64_t)card.stall_us*1000u;
  sd.busy_until_ns=vt_ns+busy;sd.busy_ns_total+=busy;sd.mode=C_WR_BUSY;return 0xE5;}
 case C_WR_BUSY:
  if(vt_ns<sd.busy_until_ns)return 0x00;
  sd.mode=C_CMD;return 0xFF;
 case C_RD_WAIT:
  if(sd.out_head<sd.out_tail)return sd.out[sd.out_head++];
  if(vt_ns<sd.token_ns)return 0xFF;
  {const uint8_t *d=sector_at(sd.rlba,false);static const uint8_t zero[512];if(!d)d=zero;
   sd.out_head=sd.out_tail=0;for(unsigned i=0;i<512;i++)out_push(d[i]);uint16_t c=sd_crc16(d,512);out_push((uint8_t)(c>>8));out_push((uint8_t)c);}
  sd.mode=C_CMD;return 0xFE;
 default:break;
 }
 if(sd.cmd_n==0){
  if((tx&0xC0)==0x40){sd.cmd[0]=tx;sd.cmd_n=1;return 0xFF;}
  return sd.out_head<sd.out_tail?sd.out[sd.out_head++]:0xFF;
 }
 sd.cmd[sd.cmd_n++]=tx;if(sd.cmd_n==6){sd.cmd_n=0;sd_command();}
 return 0xFF;
}
static void io_cs(bool on,void *ctx){(void)ctx;sd.cs=on;if(!on)sd.cmd_n=0;}
static void io_speed(sd_spi_speed_t s,void *ctx){(void)ctx;sd.slow=s==SD_SPI_SPEED_SLOW;}
static void io_start(uint8_t tx,void *ctx){(void)ctx;assert(!sd.pending);sd.pending=true;sd.rx=sd_byte(tx);sd.done_ns=vt_ns+(sd.slow?SLOW_BYTE_NS:FAST_BYTE_NS);}
static sd_spi_io_status_t io_poll(uint8_t *rx,void *ctx){(void)ctx;vt_ns+=POLL_CALL_NS;
 if(!sd.pending||vt_ns<sd.done_ns)return SD_SPI_IO_PENDING;sd.pending=false;*rx=sd.rx;return SD_SPI_IO_DONE;}
static unsigned binds,cancels;
bool sd_spi_hw_bind(sd_spi_io_t *io){binds++;*io=(sd_spi_io_t){io_cs,io_speed,io_start,io_poll,0};return true;}
void sd_spi_hw_cancel(void){cancels++;sd.cs=false;sd.pending=false;}

#define BOBFLIGHT_MCU 1
#define BOBFLIGHT_VERSION_STRING "0.2.0-throughput-model"
#include "drivers/sd_cli.h"
#include "drivers/blackbox_cli.h"

/* ---------------- FAT32 fixture with a large pre-existing file ---------------- */
static void put16(uint8_t *p,unsigned v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static void put32(uint8_t *p,uint32_t v){put16(p,v&0xffffu);put16(p+2,v>>16);}
static uint32_t get32(const uint8_t *p){return p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
#define EXISTING_CLUSTERS 20000u /* ~312 MiB already on the card before the log */
static void fixture(void){
 memset(store,0,sizeof store);stored=0;
 uint8_t *b=sector_at(0,true);b[0]=0xeb;b[1]=0x58;b[2]=0x90;memcpy(b+3,"MSWIN4.1",8);put16(b+11,512);b[13]=32;put16(b+14,32);b[16]=2;b[21]=0xf8;put32(b+32,CARD_SECTORS);put32(b+36,FAT_SECTORS);put32(b+44,2);put16(b+48,1);put16(b+50,6);memcpy(b+82,"FAT32   ",8);put16(b+510,0xaa55);memcpy(sector_at(6,true),b,512);
 uint8_t *info=sector_at(1,true);put32(info,0x41615252);put32(info+484,0x61417272);put32(info+488,0xffffffff);put32(info+492,4);put32(info+508,0xaa550000);memcpy(sector_at(7,true),info,512);
 /* Clusters 0..2 reserved/root; KEEP.BIN occupies 3..3+EXISTING-1 as one chain. */
 for(uint32_t c=0;c<3u+EXISTING_CLUSTERS;c++){
  uint32_t v=c==0?0x0ffffff8u:c<3u?0x0fffffffu:(c==2u+EXISTING_CLUSTERS?0x0fffffffu:c+1u);
  uint8_t *f1=sector_at(32u+c/128u,true);put32(f1+(c%128u)*4u,v);
  uint8_t *f2=sector_at(32u+FAT_SECTORS+c/128u,true);put32(f2+(c%128u)*4u,v);
 }
 uint8_t *root=sector_at(DATA_LBA,true);memcpy(root,"KEEP    BIN",11);root[11]=0x20;put16(root+26,3);put32(root+28,EXISTING_CLUSTERS*16384u);
}

/* ---------------- run one session ---------------- */
typedef struct {
 uint32_t frames,dropped,accepted,missed,rate,requested,lowerings;char reason[40],pct_str[16];double pct;
 uint64_t bytes,sector_writes,sector_reads;size_t ring_peak,header_len;
 uint32_t max_overrun_us,max_late_us;char status[1024];
} result_t;
static const char *status_value(const char *status,const char *key,char *dst,size_t cap){
 char pat[64];snprintf(pat,sizeof pat,"%s: ",key);const char *p=strstr(status,pat);if(!p)return NULL;p+=strlen(pat);
 size_t n=0;while(p[n]&&p[n]!='\r'&&n+1<cap){dst[n]=p[n];n++;}dst[n]=0;return dst;
}
/* One loop configuration: scheduler_init(gyro_hz, denom). Costs are virtual
 * CPU time per slot (LOOP-RATE.md timing budget, not measured on hardware). */
typedef struct {
 const char *name;uint32_t gyro_hz,denom;
 uint64_t gyro_only_ns; /* gyro-only slot (denom > 1) */
 uint64_t pid_slot_ns;  /* gyro + PID cascade slot, incl. capture */
 uint64_t bg_ns;        /* USB/CLI work around each background call */
} loop_cfg_t;
static uint32_t late_slots;
static double model_t;
/* Schema 3 slow inputs: realistic eRPM (12-30k), all telemetry OK, notch1 + RPM ok. */
static void model_fill(bb_capture_extra_t *x){
 vt_ns+=1000u; /* 4 telemetry reads + RPM snapshot, logged samples only */
 for(unsigned m=0;m<4;m++)x->erpm[m]=(uint32_t)(21000.0+9000.0*sin(model_t*3.0+m));
 x->telem_ok=0xF;x->filter_flags=bb_filter_flags_pack(true,false,3u,3u);
}
static result_t run(const loop_cfg_t *loop,const card_model_t *model,double seconds){
 card=*model;memset(&sd,0,sizeof sd);fixture();vt_ns=0;next_gyro_us=0;late_slots=0;
 config_init();pid_init();recorder_stop();
 model_sched.gyro_hz=loop->gyro_hz;model_sched.pid_process_denom=loop->denom;
 output[0]=0;assert(cmd_blackbox("blackbox start")&&strstr(output,"initializing"));
 const uint64_t period_us=1000000u/loop->gyro_hz;const double pid_dt=(double)loop->denom/(double)loop->gyro_hz;
 const uint64_t cli_overhead_ns=loop->bg_ns;
 bb_capture_ctx_t ctx={bb_loop_code(loop->gyro_hz/loop->denom),false,0,model_fill};
 uint64_t end_us=(uint64_t)(seconds*1e6);bool stopped=false;uint32_t max_overrun=0,max_late=0;unsigned pid_n=0,slot=0;
 while(blackbox_cli_busy()){
  uint64_t now_us=vt_ns/1000u;
  if(now_us>=next_gyro_us){
   if(next_gyro_us&&now_us-next_gyro_us>max_late&&bbl.phase==BBS_RECORDING)max_late=(uint32_t)(now_us-next_gyro_us);
   uint64_t late=now_us-next_gyro_us;if(next_gyro_us&&late>=period_us)late_slots++;
   next_gyro_us+=(late/period_us+1u)*period_us;
   if((slot++%loop->denom)!=0u){vt_ns+=loop->gyro_only_ns;continue;}
   /* PID slot: realistic, time-varying flight-like values. */
   double t=(double)pid_n*pid_dt;pid_n++;model_t=t;
   float raw[3]={(float)(180*sin(t*7.1)+9*sin(t*431)),(float)(-140*sin(t*5.3+1)+7*sin(t*377)),(float)(60*sin(t*2.2)+3*sin(t*211))};
   float gyro[3]={raw[0]*.97f,raw[1]*.97f,raw[2]*.97f},sp[3]={(float)(190*sin(t*7.1)),(float)(-150*sin(t*5.3+1)),(float)(65*sin(t*2.2))};
   float motor[4]={(float)(.45+.2*sin(t*3)),(float)(.47+.2*sin(t*3.1)),(float)(.43+.2*sin(t*2.9)),(float)(.46+.2*sin(t*3.2))};
   float rc[4]={(float)(.6*sin(t*.7)),(float)(-.4*sin(t*.5)),(float)(.2*sin(t*.3)),(float)(.5+.2*sin(t*.2))};
   pid_axis_out_t out;pid_set_dt((float)pid_dt);pid_update(gyro,sp,&out);
   vt_ns+=loop->pid_slot_ns;ctx.overruns_total=late_slots;
   bb_capture_observe_ex(hal_micros(),raw,gyro,sp,&out,motor,rc,true,0,0,true,true,true,&ctx);
   if(!stopped&&bbl.phase==BBS_RECORDING&&hal_micros()>=end_us){output[0]=0;cmd_blackbox("blackbox stop");stopped=true;}
   if(vt_ns/1000u>end_us+60000000u)break; /* hang guard */
   continue;
  }
  /* scheduler_run background slice (cli_poll), then main.c's extra cli_poll. */
  for(unsigned k=0;k<2;k++){
   vt_ns+=cli_overhead_ns;uint64_t deadline=0;
   uint64_t before=vt_ns/1000u;(void)before;
   blackbox_cli_poll();deadline=bbl_deadline;
   uint64_t after=vt_ns/1000u;
   if(bbl.phase==BBS_RECORDING&&after>deadline&&after-deadline>max_overrun)max_overrun=(uint32_t)(after-deadline);
  }
 }
 result_t r={0};output[0]=0;assert(cmd_blackbox("blackbox status"));snprintf(r.status,sizeof r.status,"%s",output);
 char v[64];
 r.frames=(uint32_t)atol(status_value(output,"blackbox_frames",v,sizeof v));
 r.dropped=(uint32_t)atol(status_value(output,"blackbox_dropped",v,sizeof v));
 r.rate=(uint32_t)atol(status_value(output,"blackbox_rate_hz",v,sizeof v));
 r.requested=(uint32_t)atol(status_value(output,"blackbox_rate_requested_hz",v,sizeof v));
 r.pct=atof(status_value(output,"blackbox_drop_pct",r.pct_str,sizeof r.pct_str));r.header_len=bbl.header_len;
 status_value(output,"blackbox_rate_reason",r.reason,sizeof r.reason);
 r.accepted=recorder_stats()->total_accepted;r.missed=recorder_stats()->total_missed;r.lowerings=bbl.rate_lowerings;r.bytes=bbl.file.bytes_written;
 r.sector_writes=sd.writes;r.sector_reads=sd.reads;r.ring_peak=bbl.ring_peak;r.max_overrun_us=max_overrun;r.max_late_us=max_late;
 return r;
}
/* Extract the closed file through its directory entry and FAT chain. */
static size_t extract(uint8_t *dst,size_t cap){
 uint8_t *root=sector_at(DATA_LBA,false);assert(root);uint8_t *e=root+32;assert(!memcmp(e,"BFL00001BBL",11));
 uint32_t size=get32(e+28);assert(size<=cap);uint32_t cl=((uint32_t)(e[20]|(e[21]<<8))<<16)|(e[26]|(e[27]<<8));size_t pos=0;
 while(pos<size){assert(cl>=3u+EXISTING_CLUSTERS);for(unsigned j=0;j<32&&pos<size;j++){size_t n=size-pos;if(n>512)n=512;uint8_t *s=sector_at(DATA_LBA+(cl-2u)*32u+j,false);assert(s);memcpy(dst+pos,s,n);pos+=n;}
  uint8_t *f=sector_at(32u+cl/128u,false);assert(f);cl=get32(f+(cl%128u)*4u)&0x0fffffffu;}
 assert(cl>=0x0ffffff8u);return size;
}
static void check_status_contract(const char *st){
 /* api-1 keys keep their order; api-2 keys follow blackbox_active; framed. */
 const char *keys[]={"blackbox_api: 2\r\n","blackbox_state: ","blackbox_reason: ","blackbox_file: ","blackbox_bytes: ","blackbox_frames: ","blackbox_rate_hz: ","blackbox_dropped: ","blackbox_missed: ","blackbox_invalid: ","blackbox_queue: ","blackbox_active: ","blackbox_rate_requested_hz: ","blackbox_rate_reason: ","blackbox_drop_pct: ","blackbox_end: 1\r\n"};
 const char *p=st;for(unsigned i=0;i<sizeof keys/sizeof keys[0];i++){const char *q=strstr(p,keys[i]);if(!q){fprintf(stderr,"missing/out-of-order %s in:\n%s",keys[i],st);abort();}p=q+strlen(keys[i]);}
 char v[64];status_value(st,"blackbox_drop_pct",v,sizeof v);const char *dot=strchr(v,'.');assert(dot&&strlen(dot)==2&&dot[1]>='0'&&dot[1]<='9');
 char r[40];status_value(st,"blackbox_rate_reason",r,sizeof r);assert(!strcmp(r,"default")||!strcmp(r,"auto-lowered-card-slow"));
 double frames=atof(status_value(st,"blackbox_frames",v,sizeof v)),dropped=atof(status_value(st,"blackbox_dropped",v,sizeof v));
 double pct=atof(status_value(st,"blackbox_drop_pct",v,sizeof v)),want=frames+dropped>0?dropped*100.0/(frames+dropped):0.0;
 assert(fabs(pct-want)<=0.05+1e-9);
}
static void report(const loop_cfg_t *l,const card_model_t *m,const result_t *r,double seconds){
 printf("%-8s %-36s %4.0fs: frames=%lu dropped=%lu (%s%%) missed=%lu rate=%lu/%lu reason=%s lowerings=%lu bytes=%llu B/frame=%.1f sectorW=%llu R=%llu ring_peak=%zu B quantum_overrun_max=%lu us gyro_late_max=%lu us\n",
  l->name,m->name,seconds,(unsigned long)r->frames,(unsigned long)r->dropped,r->pct_str,(unsigned long)r->missed,(unsigned long)r->rate,(unsigned long)r->requested,r->reason,(unsigned long)r->lowerings,(unsigned long long)r->bytes,
  r->frames?(double)(r->bytes-r->header_len-13u)/r->frames:0.0,
  (unsigned long long)r->sector_writes,(unsigned long long)r->sector_reads,r->ring_peak,(unsigned long)r->max_overrun_us,(unsigned long)r->max_late_us);
}
static uint8_t file_buf[4u<<20];
static FILE *status_out; /* optional: argv[1] receives each final status for the Configurator contract */
static void save_status(const char *st){if(status_out){fputs(st,status_out);fputs("---\n",status_out);}}
#define REQ BLACKBOX_RATE_DEFAULT_HZ
static const loop_cfg_t loops[]={
 {"1000/1",1000,1,0,80000,12000},      /* 1 kHz: one 80 us cascade per 1000 us slot */
 {"8000/2",8000,2,30000,80000,8000},   /* 4 kHz PID: gyro-only 30 us, PID slot 80 us of 125 us */
 {"8000/1",8000,1,0,80000,8000},       /* 8 kHz PID: every 125 us slot is an 80 us PID slot */
};
#define LOOPS (sizeof loops/sizeof loops[0])
int main(int argc,char **argv){
 setvbuf(stdout,NULL,_IONBF,0);
 if(getenv("BB_SWEEP")){ /* exploration only: card busy sweep per loop */
  double secs=atof(getenv("BB_SWEEP"));if(secs<=0)secs=12;
  const uint32_t busy[]={2000,3000,4000,5000,6000,7000,8000,10000,12000,15000,20000};
  for(unsigned l=0;l<LOOPS;l++){card_model_t c={"realistic card (0.8ms busy, stalls)",800,400,128,80000};result_t r=run(&loops[l],&c,secs);report(&loops[l],&c,&r,secs);
   for(unsigned b=0;b<sizeof busy/sizeof busy[0];b++){char nm[48];snprintf(nm,sizeof nm,"%u us busy",(unsigned)busy[b]);card_model_t k={nm,busy[b],400,0,0};r=run(&loops[l],&k,secs);report(&loops[l],&k,&r,secs);}}
  return 0;
 }
 if(argc>1){status_out=fopen(argv[1],"w");assert(status_out);}
 char want[256];
 printf("requested rate %u Hz (BLACKBOX_RATE_DEFAULT_HZ), schema 3 frame bound %u B\n",(unsigned)REQ,(unsigned)BLACKBOX_FRAME_MAX_BYTES);
 /* Idle status before any session: api 2, effective == requested == default. */
 output[0]=0;assert(cmd_blackbox("blackbox status"));check_status_contract(output);save_status(output);
 snprintf(want,sizeof want,"blackbox_rate_hz: %u\r\n",(unsigned)REQ);assert(strstr(output,want));
 snprintf(want,sizeof want,"blackbox_rate_requested_hz: %u\r\n",(unsigned)REQ);assert(strstr(output,want));
 assert(strstr(output,"blackbox_rate_reason: default\r\n")&&strstr(output,"blackbox_drop_pct: 0.0\r\n"));

 /* (a) Drop matrix, realistic card: 0.8 ms programming per block, 0.4 ms read
  * access and an 80 ms garbage-collection stall every 128 blocks, on a card
  * that already holds ~312 MiB (exercises the FAT allocation hint). */
 card_model_t good={"realistic card (0.8ms busy, stalls)",800,400,128,80000};
 double secs=20;result_t r;
 for(unsigned l=0;l<LOOPS;l++){
  const loop_cfg_t *lp=&loops[l];const uint32_t loop_hz=lp->gyro_hz/lp->denom;
  r=run(lp,&good,secs);report(lp,&good,&r,secs);check_status_contract(r.status);if(l==0)save_status(r.status);
  assert(bbl.phase==BBS_DONE&&r.frames==r.accepted&&r.requested==REQ);
  assert(r.max_overrun_us<=2);    /* background quantum ends at its deadline (one byte step) */
  assert(r.max_late_us<=25);      /* gyro slot lateness bound (model: <= 2 x background overhead) */
  assert(r.sector_reads<r.sector_writes*3u/2u); /* one readback per data write, no FAT rescan */
  size_t n=extract(file_buf,sizeof file_buf);assert(n==r.bytes&&n>13&&!memcmp(file_buf+n-13,"E\xff" "End of log",13));
  assert(strstr((char*)file_buf,"\nH BobFlight log_schema:3\n"));
  snprintf(want,sizeof want,"\nH BobFlight loop_rate_hz:%u gyro_hz:%u pid_denom:%u\n",(unsigned)loop_hz,(unsigned)lp->gyro_hz,(unsigned)lp->denom);assert(strstr((char*)file_buf,want));
  const double bpf=(double)(n-r.header_len-13u)/r.frames;assert(bpf>40.0&&bpf<=(double)BLACKBOX_FRAME_MAX_BYTES);
  if(REQ==1000u&&loop_hz==8000u){
   /* Honest limit: at an 8 kHz PID loop the background budget per 125 us slot
    * cannot carry 1000 frames/s through this card's stalls. The writer must not
    * hide it: one deterministic halving to 500 Hz, losses reported, header patched. */
   assert(r.rate==500&&!strcmp(r.reason,"auto-lowered-card-slow")&&r.lowerings==1);
   assert(r.dropped>0&&r.pct>0.0&&r.pct<10.0);
   assert(strstr((char*)file_buf,"H I interval:16\nH P interval:1/16\nH BobFlight log_rate_hz:500 requested_hz:1000 reason:auto-lowered-card-slow "));
   assert(!strstr((char*)file_buf,"log_rate_hz:1000 "));
   printf("  %s @ %u Hz: NOT zero-drop on the realistic card: auto-lowered once to 500 Hz, %lu dropped (%s%%) before the halving\n",lp->name,(unsigned)REQ,(unsigned long)r.dropped,r.pct_str);
  }else{
   assert(r.rate==REQ&&!strcmp(r.reason,"default")&&r.lowerings==0);
   assert(r.dropped==0&&!strcmp(r.pct_str,"0.0")&&r.pct==0.0);
   assert(r.ring_peak<=32u*1024u);
   assert(r.frames>=(uint32_t)(REQ*(secs-1.0)*0.75)); /* minus file prepare and jitter-missed slots (see missed=) */
   snprintf(want,sizeof want,"H I interval:%u\nH P interval:1/%u\nH BobFlight log_rate_hz:%u requested_hz:%u reason:default ",
    (unsigned)(loop_hz/REQ),(unsigned)(loop_hz/REQ),(unsigned)REQ,(unsigned)REQ);assert(strstr((char*)file_buf,want));
   printf("  %s @ %u Hz: zero drops; %.1f encoded B/frame -> %.1f KiB/s; ring peak %zu B; gyro late max %lu us\n",lp->name,(unsigned)REQ,bpf,bpf*REQ/1024.0,r.ring_peak,(unsigned long)r.max_late_us);
  }
 }

 /* (b) Threshold card per loop rate: just too slow for the requested rate,
  * fast enough for half of it -> exactly one halving, header patched in place. */
 {const uint32_t busy500[LOOPS]={15000,12000,8000},busy1k[LOOPS]={6000,5000,2000};
  for(unsigned l=0;l<LOOPS;l++){
   const loop_cfg_t *lp=&loops[l];const uint32_t loop_hz=lp->gyro_hz/lp->denom,half=REQ/2u;
   char nm[48];const uint32_t busy=REQ==1000u?busy1k[l]:busy500[l];snprintf(nm,sizeof nm,"threshold card (%lu us busy)",(unsigned long)busy);
   card_model_t thr={nm,busy,400,0,0};secs=12;r=run(lp,&thr,secs);report(lp,&thr,&r,secs);check_status_contract(r.status);if(l==0)save_status(r.status);
   assert(bbl.phase==BBS_DONE&&r.frames==r.accepted);
   assert(r.rate==half&&r.requested==REQ&&!strcmp(r.reason,"auto-lowered-card-slow")&&r.lowerings==1);
   assert(r.dropped>0&&r.pct>0.0&&r.pct<20.0); /* honest: early drops stay reported */
   snprintf(want,sizeof want,"blackbox_rate_hz: %u\r\n",(unsigned)half);assert(strstr(r.status,want)&&strstr(r.status,"blackbox_rate_reason: auto-lowered-card-slow\r\n"));
   size_t n=extract(file_buf,sizeof file_buf);assert(n==r.bytes);
   snprintf(want,sizeof want,"H I interval:%u\nH P interval:1/%u\nH BobFlight log_rate_hz:%u requested_hz:%u reason:auto-lowered-card-slow ",
    (unsigned)(loop_hz/half),(unsigned)(loop_hz/half),(unsigned)half,(unsigned)REQ);assert(strstr((char*)file_buf,want));
   snprintf(want,sizeof want,"log_rate_hz:%u ",(unsigned)REQ);assert(!strstr((char*)file_buf,want));
  }}

 /* (c) 1000/1 with a harsh foreground: 60 us of USB/CLI work around every
  * background call. Under this exact model the pre-fix writer (8 us/16-step
  * quantum, double readback, FAT rescan from cluster 2) lost ~86% of frames. */
 {loop_cfg_t harsh_loop=loops[0];harsh_loop.name="1000/1 fg60";harsh_loop.bg_ns=60000u;
  card_model_t harsh=good;harsh.name="realistic card, 60us fg overhead";secs=20;
  r=run(&harsh_loop,&harsh,secs);report(&harsh_loop,&harsh,&r,secs);check_status_contract(r.status);
  assert(bbl.phase==BBS_DONE&&r.rate==REQ&&r.dropped==0&&r.frames==r.accepted&&r.max_overrun_us<=2);}

 /* (d) Very slow card: 70 ms per block. Halves to the 125 Hz floor, never
  * lower, never raised; remaining losses are reported, not hidden. */
 {card_model_t crawl={"very slow card (70ms busy)",70000,400,0,0};secs=12;
  r=run(&loops[0],&crawl,secs);report(&loops[0],&crawl,&r,secs);check_status_contract(r.status);save_status(r.status);
  assert(bbl.phase==BBS_DONE);
  assert(r.rate==125&&r.requested==REQ&&!strcmp(r.reason,"auto-lowered-card-slow")&&r.lowerings==(REQ==1000u?3u:2u));
  assert(r.dropped>0&&r.pct>0.0);
  size_t n=extract(file_buf,sizeof file_buf);(void)n;snprintf(want,sizeof want,"H BobFlight log_rate_hz:125 requested_hz:%u reason:auto-lowered-card-slow",(unsigned)REQ);assert(strstr((char*)file_buf,want));}
 if(status_out)assert(!fclose(status_out));
 printf("PASS blackbox throughput model @ %u Hz requested: realistic-card drop matrix over 1000/1, 8000/2, 8000/1 (schema 3 frames, ring peak <= 32 KiB, gyro lateness <= 25 us%s); one threshold-card halving per loop with the header patched; harsh foreground; very slow card floors at 125 Hz; status api 2 contract\n",
  (unsigned)REQ,REQ==1000u?"; 8000/1 honestly auto-lowers to 500 Hz":"");
 return 0;
}
