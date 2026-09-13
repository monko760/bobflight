/* SPDX-License-Identifier: Apache-2.0
 * Read-only audit harness: real scheduler/tasks/RX/CRSF/failsafe/arming/PID/mixer/DShot.
 * Hardware, calibrated sensors and independent diagnostic hook are mocked.
 * Native executable only. Each named case runs in a fresh process.
 * DShot observations are decoded submissions to a mock HAL, NOT physical ESC behavior.
 */
#include "sched/scheduler.h"
#include "sched/tasks.h"
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/crsf.h"
#include "drivers/dshot.h"
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/attitude.h"
#include "flight/config.h"
#include "flight/mode_range.h"
#include "flight/pid.h"
#include "flight/rates.h"
#include "board/board.h"
#include "hal/hal.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#define REQUIRE(c) do { if(!(c)) { fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#c);exit(1); } } while(0)
static uint64_t now;
static bool gyro_ok=true,usb=true;
static float gyro_vec[3],accel[3]={0,0,1};
static board_t board;
struct hal_tim_dma {unsigned index;};
static struct hal_tim_dma slots[4];
static unsigned opens,submitted[4],accepted[4];
static int failing_motor=-1;
static uint8_t wire[256];static size_t used;
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000);}
bool hal_usb_cdc_connected(void){return usb;}
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
bool board_mmio_permitted(void){return true;}
void hal_gpio_init(hal_pin_t p,hal_gpio_mode_t m){(void)p;(void)m;}
void hal_gpio_write(hal_pin_t p,bool v){(void)p;(void)v;}
bool hal_tim_dma_set_bit_rate(uint32_t h){return h==300000 || h==600000;}
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *c){(void)c;REQUIRE(opens<4);slots[opens].index=opens;return &slots[opens++];}
bool hal_tim_dma_start_burst(hal_tim_dma_t *s,const uint16_t *w,size_t n){
 REQUIRE(n==20);unsigned p=0;for(unsigned j=0;j<16;j++){REQUIRE(w[j]==3||w[j]==6);p=(p<<1)|(w[j]==6);}
 for(unsigned j=16;j<20;j++)REQUIRE(w[j]==0);
 unsigned v=p>>4;REQUIRE((p&15)==((v^(v>>4)^(v>>8))&15));
 submitted[s->index]=(p>>5)&2047;
 if((int)s->index==failing_motor)return false;
 accepted[s->index]=submitted[s->index];return true;
}
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *c){REQUIRE(c->baud==420000);return (hal_uart_t*)&board;}
size_t hal_uart_read(hal_uart_t *u,uint8_t *b,size_t n){(void)u;if(n>used)n=used;memcpy(b,wire,n);memmove(wire,wire+n,used-n);used-=n;return n;}
static void feed(const uint8_t *b,size_t n){REQUIRE(used+n<=sizeof(wire));memcpy(wire+used,b,n);used+=n;}
void cli_poll(void){}
void pid_diag_update(uint64_t t,const float g[3]){(void)t;(void)g;}
void gyro_calibration_tick(void){}
bool gyro_manual_calibration_active(void){return false;}
bool gyro_calibrated(void){return true;}
bool gyro_is_healthy(void){return gyro_ok;}
bool gyro_sample(float g[3]){memcpy(g,gyro_vec,sizeof(gyro_vec));return gyro_ok;}
void gyro_filter(const float in[3],float out[3]){memcpy(out,in,sizeof(gyro_vec));}
const float *gyro_accel_g(void){return accel;}
static unsigned encode(float x){return x<=0?0:48+(unsigned)(x*1999);}
static bool all(unsigned x){for(unsigned i=0;i<4;i++)if(accepted[i]!=x)return false;return true;}
static void controls(float throttle,float aux){float c[16]={0};c[3]=throttle;c[4]=aux;rx_stub_set_channels(c,16,true);}
static void step(void){now+=1000;scheduler_run();}
static void setup(bool wrap){
 now=wrap?((uint64_t)UINT32_MAX-100)*1000:1000000;
 strcpy(board.board_id,"kakute_f7_hdv");board.motor_count=4;board.rx_uart=4;board.rx_pin=HAL_PIN_PACK(0,1);
 for(unsigned i=0;i<4;i++)board.motors[i]=(board_motor_ch_t){HAL_PIN_PACK(1,i),3,i+1};
 config_init();mode_range_init();rx_init();failsafe_init();arming_init();arming_set_gyro_healthy(true);attitude_init();rates_init();pid_init();dshot_init();scheduler_init(1000,1);
 REQUIRE(dshot_is_healthy());
}
static void start(void){
 controls(0,-1);step();REQUIRE(arming_state()==ARM_DISARMED);
 controls(0,1);step();REQUIRE(arming_state()==ARM_ARMED);
 controls(.8f,1);step();step();REQUIRE(all(encode(.8f)));
}
static void age_to(unsigned ms){while(rx_frame_age_ms()<ms)step();}
static void rcframe(uint8_t f[26]){
 uint16_t val[16];for(unsigned i=0;i<16;i++)val[i]=992;val[2]=1484;val[4]=1811;
 memset(f,0,26);f[0]=0xc8;f[1]=24;f[2]=0x16;
 for(unsigned c=0;c<16;c++)for(unsigned b=0;b<11;b++)if(val[c]&(1u<<b))f[3+(c*11+b)/8]|=1u<<((c*11+b)%8);
 f[25]=crsf_crc8(f+2,23);
}
int main(int argc,char **argv){
 REQUIRE(argc==2);const char *name=argv[1];setup(!strcmp(name,"drop-wrap"));
 if(!strcmp(name,"boot")){
  for(unsigned i=0;i<300;i++){step();}REQUIRE(failsafe_active());REQUIRE(arming_state()==ARM_DISARMED&&all(0));
  controls(0,1);step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
 }else if(!strcmp(name,"drop")||!strcmp(name,"drop-wrap")){
  start();age_to(249);REQUIRE(rx_frame_fresh()&&arming_state()==ARM_ARMED&&all(encode(.8f)));
  step();REQUIRE(rx_frame_age_ms()==250&&rx_frame_fresh()&&arming_state()==ARM_ARMED);
  step();REQUIRE(rx_frame_age_ms()==251&&!rx_frame_fresh());REQUIRE(arming_state()==ARM_DISARMED&&all(0));
  printf("DROP boundary: 249/250ms armed, 251ms disarmed; all four decoded stop commands=0, now_ms=%u\n",hal_millis());
  controls(.8f,1);step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
  controls(0,1);step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
  controls(0,-1);step();controls(0,1);step();REQUIRE(arming_state()==ARM_ARMED);
 }else if(!strcmp(name,"land-throttle")||!strcmp(name,"land-disarm")||!strcmp(name,"land-timer")){
  failsafe_set_action(FAILSAFE_ACTION_LAND);failsafe_set_land_throttle(.35f);failsafe_set_land_ms(3000);start();age_to(251);
  REQUIRE(failsafe_stage()==FAILSAFE_STAGE_PROCEDURE&&arming_state()==ARM_ARMED);
  float s[4]={0};REQUIRE(failsafe_command_override(s));REQUIRE(fabsf(s[3]-.35f)<1e-6f);
  if(!strcmp(name,"land-throttle")){
   printf("LAND override=%.2f, expected DShot=%u; actual decoded submissions=%u,%u,%u,%u (old RC throttle=%.2f)\n",s[3],encode(s[3]),accepted[0],accepted[1],accepted[2],accepted[3],rx_channels()[3]);
   REQUIRE(all(encode(.35f)));
  }else if(!strcmp(name,"land-disarm")){
   controls(.8f,-1);step();REQUIRE(!failsafe_active());REQUIRE(arming_state()==ARM_DISARMED&&all(0));
   puts("Real valid recovery+switch-low DOES disarm; earlier alleged manual-disarm bug not reproduced.");
  }else{
   for(unsigned i=0;i<2999;i++){step();}REQUIRE(arming_state()==ARM_ARMED);
   step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
   puts("LAND timer: armed at procedure+2999ms; stop at +3000ms.");
  }
 }else if(!strcmp(name,"bad-traffic")){
  start();unsigned count=rx_frame_count();uint8_t bad[26],other[4]={0xc8,2,0x14,0};rcframe(bad);bad[25]^=1;other[3]=crsf_crc8(other+2,1);
  for(unsigned i=0;i<251;i++){
   feed(bad,26);feed(other,4);
   float inv[16]={0};inv[0]=NAN;rx_stub_set_channels(inv,16,true);inv[0]=0;rx_stub_set_channels(inv,4,true);inv[3]=-1;rx_stub_set_channels(inv,16,true);
   step();
  }
  REQUIRE(rx_frame_count()==count&&arming_state()==ARM_DISARMED&&all(0));puts("BadCRC/nonRC/NaN/partial/negative-throttle traffic never refreshed RX; DROP emitted stop.");
 }else if(!strcmp(name,"repeated-valid")){
  start();unsigned count=rx_frame_count();uint8_t f[26];rcframe(f);
  for(unsigned i=0;i<600;i++){feed(f,26);step();}
  REQUIRE(rx_frame_count()==count+600&&arming_state()==ARM_ARMED);
  puts("600 identical valid RC frames keep link fresh: cannot distinguish held sticks from receiver retransmitting frozen controls.");
 }else if(!strcmp(name,"gyro-fault")){
  start();gyro_ok=false;step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
 }else if(!strcmp(name,"nonfinite-sensor")){
  start();gyro_vec[0]=NAN;step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
 }else if(!strcmp(name,"scheduler-gap")){
  start();now+=21000;scheduler_run();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
 }else if(!strcmp(name,"dma-failure")){
  start();failing_motor=0;step();REQUIRE(arming_state()==ARM_DISARMED&&!dshot_is_healthy());
  printf("Failed mock DMA submission: motor0 last accepted=%u (not proof of stop); other three=%u,%u,%u\n",accepted[0],accepted[1],accepted[2],accepted[3]);
  failing_motor=-1;step();REQUIRE(all(0));
 }else if(!strcmp(name,"direct-disarm")){
  start();arming_disarm();step();REQUIRE(arming_state()==ARM_DISARMED&&all(0));
 }else if(!strcmp(name,"usb-flight-path")){
  start();usb=false;controls(.8f,1);step();REQUIRE(arming_state()==ARM_ARMED);
  puts("USB loss alone is not flight RX loss; current native armed path continues with fresh receiver.");
 }else{fprintf(stderr,"Unknown case: %s\n",name);return 2;}
 printf("PASS audit case: %s\n",name);return 0;
}
