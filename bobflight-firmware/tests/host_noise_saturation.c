/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Safety S1 (docs/SAFETY-NOISE.md): high-frequency gyro noise must not raise
 * the average motor command ("noise rectification" -> slow climb/fly-away).
 * Real scheduler, tasks, PID, mixer, DShot encoder, RX/failsafe/arming, and
 * the real gyro filter chain (filter_gyro_chain_step, the function gyro.c
 * runs on hardware) with the soft gyro LPF at its default. Sensor, HAL and
 * DShot DMA are mocked; motor commands are decoded DShot submissions, not
 * ESC or thrust measurements.
 * Noise: roll A*sin(183 Hz) + A/2*sin(291 Hz), pitch A*sin(197 Hz) +
 * A/2*sin(305 Hz), yaw A/2*sin(211 Hz), A = 15 / 30 dps; 1 s per case,
 * first 100 ms skipped. Pass criteria per case (1000/1, 8000/2, 8000/1 x
 * throttle 0.10 / 0.20 / 0.95 x A 15 / 30):
 *   mean motor command == thr - (step-3 shift) within 1.5 DShot LSB
 *   thr 0.10/0.20: |mean - noiseless mean| <= 0.005  (b77b845: +0.04..+0.17)
 *   thr 0.95 (QA F2): mean <= noiseless mean + 1 LSB (no climb), and the
 *     drop <= 4 x the b77b845 clamp's top loss on the same PID outputs
 *   cycles where the motors are not thr + s*u (hard clipping) <= 0.5 %
 *   motor samples at a rail <= the old per-motor clamp on the same PID output
 *   every gyro sample filtered, at dt = 1/gyro_hz; still armed.
 * Plus: I-term frozen while the mixer is saturated, and grows when not.
 * `--table` prints the numbers (also D-term first- vs second-order).
 * Build with -DNOISE_BASELINE against b77b845 sources to print the "before"
 * column (no S1 APIs; nothing asserted). */
#include "sched/scheduler.h"
#include "sched/tasks.h"
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/dshot.h"
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/attitude.h"
#include "flight/config.h"
#include "flight/filter.h"
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
#define REQUIRE(c) do { if(!(c)) { fprintf(stderr,"noise_saturation FAIL line %d: %s\n",__LINE__,#c);exit(1); } } while(0)
static uint64_t now;
static float gyro_vec[3],accel[3]={0,0,1};
static board_t board;
struct hal_tim_dma {unsigned index;};
static struct hal_tim_dma slots[4];
static unsigned opens,accepted[4];
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000);}
bool hal_usb_cdc_connected(void){return true;}
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
bool board_mmio_permitted(void){return true;}
void hal_gpio_init(hal_pin_t p,hal_gpio_mode_t m){(void)p;(void)m;}
void hal_gpio_write(hal_pin_t p,bool v){(void)p;(void)v;}
bool hal_tim_dma_set_bit_rate(uint32_t h){return h==300000 || h==600000;}
bool dshot_bidir_enabled(void){return false;}
void dshot_telem_arm_listen(unsigned motor){(void)motor;}
void dshot_telem_arm_listen_all(void){}
void dshot_telem_poll_all(void){}
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *c){(void)c;REQUIRE(opens<4);slots[opens].index=opens;return &slots[opens++];}
bool hal_tim_dma_start_burst(hal_tim_dma_t *s,const uint16_t *w,size_t n){
 REQUIRE(n==20);unsigned p=0;for(unsigned j=0;j<16;j++){REQUIRE(w[j]==3||w[j]==6);p=(p<<1)|(w[j]==6);}
 accepted[s->index]=(p>>5)&2047;return true;
}
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *c){(void)c;return (hal_uart_t*)&board;}
size_t hal_uart_read(hal_uart_t *u,uint8_t *b,size_t n){(void)u;(void)b;(void)n;return 0;}
void cli_poll(void){}
void pid_diag_update(uint64_t t,const float g[3]){(void)t;(void)g;}
void gyro_calibration_tick(void){}
bool gyro_manual_calibration_active(void){return false;}
bool gyro_calibrated(void){return true;}
bool gyro_flight_ready(void){return true;}
bool gyro_is_healthy(void){return true;}
static unsigned long samples,filtered;static float filter_dt=-1.f;
bool gyro_sample(float g[3]){memcpy(g,gyro_vec,sizeof(gyro_vec));samples++;return true;}
const float *gyro_accel_g(void){return accel;}
/* The real chain gyro.c runs on hardware (LPF at gyro_lpf_hz, then notches). */
static float lpf_state[3];static filter_notch_bank_t notch;
void gyro_filter_set_dt(float dt){filter_dt=dt;}
void gyro_filter(const float in[3],float out[3]){
 const bf_config_t *cfg=config_get();filtered++;
 const float c[2]={cfg->gyro_notch1_hz,cfg->gyro_notch2_hz},f[2]={cfg->gyro_notch1_cutoff_hz,cfg->gyro_notch2_cutoff_hz};
 (void)filter_notch_bank_update(&notch,c,f,filter_dt);
#ifdef NOISE_BASELINE
 const float a=filter_lpf_alpha(cfg->gyro_lpf_hz,filter_dt);
 for(unsigned i=0;i<3;i++)out[i]=filter_lpf_step(&lpf_state[i],in[i],a);
 filter_notch_bank_apply(&notch,out);
#else
 filter_gyro_chain_step(lpf_state,&notch,cfg->gyro_lpf_hz,filter_dt,in,out);
#endif
}
static void controls(float throttle,float aux){float c[16]={0};c[3]=throttle;c[4]=aux;rx_stub_set_channels(c,16,true);}
static void run_us(uint64_t us){uint64_t end=now+us;while(now<end){now+=5;scheduler_run();}}
static void setup(uint32_t g,uint32_t d,bool pt2){
 now=1000000;opens=0;memset(accepted,0,sizeof accepted);memset(gyro_vec,0,sizeof gyro_vec);memset(lpf_state,0,sizeof lpf_state);
 filter_notch_bank_init(&notch);
 strcpy(board.board_id,"kakute_f7_hdv");board.motor_count=4;board.rx_uart=4;board.rx_pin=HAL_PIN_PACK(0,1);
 for(unsigned i=0;i<4;i++)board.motors[i]=(board_motor_ch_t){HAL_PIN_PACK(1,i),3,i+1};
 config_init();mode_range_init();rx_init();failsafe_init();arming_init();arming_set_gyro_healthy(true);attitude_init();rates_init();pid_init();dshot_init();
#ifndef NOISE_BASELINE
 pid_set_dterm_lpf_pt2(pt2);
#else
 (void)pt2;
#endif
 scheduler_init(g,d);
 controls(0,-1);run_us(2000);controls(0,1);run_us(2000);REQUIRE(arming_state()==ARM_ARMED);
}
static double dec(unsigned a){return a?(a-48)/1999.0:0;}
typedef struct {double mean,mean_sq,rail,legacy_rail,hard,legacy_hard,scale,pred_mean,legacy_hi_loss;unsigned long filt,samp;bool armed,dt_ok;} stats_t;
static const float TWO_PI=6.28318531f;
static stats_t run_case(uint32_t g,uint32_t d,float amp,float thr,bool pt2){
 setup(g,d,pt2);
 const double mt=config_get()->min_throttle,lsb=1.0/1999.0;
 double sum=0,sq=0,scale=0,pred=0,lhi=0;unsigned long n=0,rail=0,lrail=0,cyc=0,hard=0,lhard=0,scn=0;
 unsigned long last=scheduler_stats()->pid_runs;uint64_t t0=now;pid_trace_enable(true);
 unsigned long g0=0,f0=0;bool dt_ok=true;
 while(now-t0<1000000){
  now+=5;const float t=(float)(now-t0)*1e-6f;
  gyro_vec[0]=amp*sinf(TWO_PI*183.f*t)+0.5f*amp*sinf(TWO_PI*291.f*t+1.f);
  gyro_vec[1]=amp*sinf(TWO_PI*197.f*t+2.f)+0.5f*amp*sinf(TWO_PI*305.f*t);
  gyro_vec[2]=0.5f*amp*sinf(TWO_PI*211.f*t+0.5f);
  if((now-t0)%4000==0)controls(thr,1);
  if(now-t0==100000){g0=samples;f0=filtered;}
  scheduler_run();
  if(filter_dt>0.f&&fabsf(filter_dt-1.f/(float)g)>1e-9f)dt_ok=false;
  if(scheduler_stats()->pid_runs==last)continue;
  last=scheduler_stats()->pid_runs;
  if(now-t0<=100000)continue;
  pid_trace_t tr;if(!pid_trace_read(&tr))continue;
  const float r=tr.output[0],p=tr.output[1],y=tr.output[2];
  const double u[4]={-r+p-y,-r-p+y,r+p+y,r-p-y},T=thr<mt?mt:thr;
  double m[4],mm=0,uu=0,mu=0;bool lclip=false;
  for(unsigned i=0;i<4;i++){
   m[i]=dec(accepted[i]);mm+=m[i]/4;sum+=m[i];sq+=m[i]*m[i];n++;
   if(accepted[i]==2047||accepted[i]<=48+(unsigned)(0.05f*1999)+1)rail++;
   const double l=T+u[i]<mt?mt:(T+u[i]>1?1:T+u[i]);   /* b77b845 per-motor clamp */
   if(l<=mt+lsb||l>=1-lsb)lrail++;
   if(fabs(l-(T+u[i]))>1e-6)lclip=true;
  }
  /* Hard clipping = motors are not (common level) + s*u for one s in [0,1]. */
  for(unsigned i=0;i<4;i++){uu+=u[i]*u[i];mu+=(m[i]-mm)*u[i];}
  double s=uu>1e-12?mu/uu:1;if(s>1)s=1;if(s<0)s=0;double res=0;
  for(unsigned i=0;i<4;i++){const double e=fabs(m[i]-mm-s*u[i]);if(e>res)res=e;}
  if(res>2.5*lsb)hard++;
  if(lclip)lhard++;
  if(uu>1e-12){scale+=s;scn++;}
  /* Step 3 model: the common level is thr minus the shift that brings the
   * highest (already scaled) motor down to 1, nothing else (airmode off). */
  {double umax=u[0];for(unsigned i=1;i<4;i++)if(u[i]>umax)umax=u[i];
   const double ex=T+s*umax-1;pred+=T-(ex>0?ex:0);
   for(unsigned i=0;i<4;i++){const double e=T+u[i]-1;if(e>0)lhi+=e/4;}}   /* b77b845 clamp: top loss */
  cyc++;
 }
 stats_t st={sum/n,sq/n,(double)rail/n,(double)lrail/n,(double)hard/cyc,(double)lhard/cyc,scn?scale/scn:1,pred/cyc,lhi/cyc,
  filtered-f0,samples-g0,arming_state()==ARM_ARMED,dt_ok};
 return st;
}
/* I-term anti-windup: a constant 100 dps roll error that the mixer cannot
 * deliver at throttle 0.10 (P alone asks 0.2) vs a 2 dps error at 0.50.
 * Returns the I term (pid_roll_i * accumulator, default ki 0.001). */
static float iterm_after(float thr,float err_dps){
 setup(8000,2,true);controls(thr,1);gyro_vec[0]=-err_dps;
 pid_trace_enable(true);for(unsigned k=0;k<75;k++){controls(thr,1);run_us(4000);}   /* fresh RX every 4 ms */
 pid_trace_t tr;const bool ok=pid_trace_read(&tr);
 REQUIRE(ok);REQUIRE(arming_state()==ARM_ARMED);return tr.i[0];
}
/* The shared chain applies the notches after the LPF: a 200 Hz notch
 * (cutoff 150) removes a 200 Hz tone at 8 kHz; with the notch off the LPF
 * alone passes most of it. */
static float chain_peak(bool with_notch){
 float st[3]={0,0,0},peak=0;filter_notch_bank_t b;filter_notch_bank_init(&b);
 const float c[2]={with_notch?200.f:0.f,0.f},f[2]={with_notch?150.f:0.f,0.f};
 (void)filter_notch_bank_update(&b,c,f,1.f/8000.f);
 for(int k=0;k<16000;k++){
  const float x=10.f*sinf(TWO_PI*200.f*(float)k/8000.f),in[3]={x,x,x};float out[3];
#ifdef NOISE_BASELINE
  const float a=filter_lpf_alpha(320.f,1.f/8000.f);for(unsigned i=0;i<3;i++)out[i]=filter_lpf_step(&st[i],in[i],a);filter_notch_bank_apply(&b,out);
#else
  filter_gyro_chain_step(st,&b,320.f,1.f/8000.f,in,out);
#endif
  if(k>8000&&fabsf(out[0])>peak)peak=fabsf(out[0]);
 }
 return peak;
}
int main(int argc,char **argv){
 const bool table=argc>1&&!strcmp(argv[1],"--table");
 {const float off=chain_peak(false),on=chain_peak(true);
  if(table)printf("gyro chain, 10 dps 200 Hz tone at 8 kHz: LPF only peak %.2f, LPF + 200 Hz notch peak %.3f\n",off,on);
#ifndef NOISE_BASELINE
  REQUIRE(off>7.f&&on<0.5f);
#endif
 }
 const uint32_t rates[3][2]={{1000,1},{8000,2},{8000,1}};
 const float amps[2]={15.f,30.f},thrs[3]={0.10f,0.20f,0.95f};
#ifdef NOISE_BASELINE
 const bool modes[1]={false};const unsigned nmodes=1;
#else
 const bool modes[2]={true,false};const unsigned nmodes=table?2:1;   /* shipped Kakute: D-term 2nd order */
#endif
 if(table)puts("rate     dterm thr  amp | mean    d_mean  mean^2  | rail%  old-clamp-rail% | hardclip% old-clamp% | authority | step3-model old-top-loss | filtered/samples");
 for(unsigned md=0;md<nmodes;md++)for(unsigned ri=0;ri<3;ri++)for(unsigned ti=0;ti<3;ti++){
  const uint32_t g=rates[ri][0],d=rates[ri][1];
  const stats_t q=run_case(g,d,0.f,thrs[ti],modes[md]);
  for(unsigned ai=0;ai<2;ai++){
   const stats_t s=run_case(g,d,amps[ai],thrs[ti],modes[md]);
   if(table)printf("%4u/%u   %s  %.2f %2.0f  | %.4f %+.4f %.4f  | %5.1f  %5.1f           | %5.1f    %5.1f      | %.3f     | %.4f      %.4f       | %lu/%lu\n",
     g,d,modes[md]?"PT2":"PT1",thrs[ti],amps[ai],s.mean,s.mean-q.mean,s.mean_sq,100*s.rail,100*s.legacy_rail,100*s.hard,100*s.legacy_hard,s.scale,s.pred_mean,s.legacy_hi_loss,s.filt,s.samp);
#ifndef NOISE_BASELINE
   const double LSB=1.0/1999.0;      /* one DShot throttle step */
   REQUIRE(s.armed);
   REQUIRE(s.hard<=0.005);
   REQUIRE(s.rail<=s.legacy_rail);
   REQUIRE(s.filt==s.samp&&s.dt_ok);   /* every gyro sample filtered at 1/gyro_hz */
   /* The mean is exactly the documented rule: thr minus the step-3 shift
    * (1.5 LSB: DShot quantisation of the decoded commands and of the fit). */
   REQUIRE(fabs(s.mean-s.pred_mean)<=1.5*LSB);
   if(thrs[ti]<0.5f){
    REQUIRE(fabs(s.mean-q.mean)<=0.005);   /* low throttle: no climb, no sag */
   }else{
    /* High throttle (QA F2): noise may only LOWER the mean (never a climb),
     * and by at most 4x what the b77b845 per-motor clamp lost at the top on
     * the same PID outputs: the shift is the largest motor excess, the old
     * loss was the average of the four excesses, and max <= sum = 4 x mean. */
    REQUIRE(s.mean<=q.mean+LSB);
    REQUIRE(thrs[ti]-s.mean<=4.0*s.legacy_hi_loss+LSB);
   }
#endif
  }
 }
#ifndef NOISE_BASELINE
 const float i_sat=iterm_after(0.10f,100.f),i_free=iterm_after(0.50f,2.f);
 if(table)printf("I term after 300 ms: saturated (thr 0.10, 100 dps) %.6f, unsaturated (thr 0.50, 2 dps) %.6f\n",i_sat,i_free);
 REQUIRE(fabsf(i_sat)<0.00005f);   /* frozen: accumulator < 0.05 (~2 cycles of 100 dps * 250 us); unfrozen it would reach 0.05 (I_LIMIT 50) */
 REQUIRE(i_free>0.0004f);          /* integrates normally: accumulator ~ 2..4 dps * 0.3 s */
 puts("PASS noise_saturation: 15/30 dps HF noise at throttle 0.10/0.20 on 1000/1, 8000/2, 8000/1 keeps the mean motor command within 0.005 of noiseless; at 0.95 it only lowers it (step-3 shift, <= 4x old top loss); mean == rule within 1.5 LSB; no hard clipping, rail time <= old clamp, every gyro sample filtered; I-term frozen while saturated");
#endif
 return 0;
}
