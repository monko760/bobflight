/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
#include <string.h>
#include <limits.h>
static uint64_t epoch,previous;
static uint32_t iteration,overruns_base;
static bool have_previous,have_state,have_overruns;
/* Previous per-loop state for edge detection, and events not yet logged. */
static struct {bool armed,rx_fresh,telem_failed;uint8_t mode,failsafe,loop_code;} last;
static uint8_t pending_events;
bool bb_capture_begin(uint32_t hz,uint64_t epoch_us){
 if(recorder_active())return false;
 recorder_reset();if(!recorder_start(hz))return false;
 epoch=epoch_us;previous=0;iteration=0;have_previous=false;have_state=false;have_overruns=false;overruns_base=0;pending_events=0;
 pid_trace_enable(true);return true;
}
void bb_capture_end(void){recorder_stop();pid_trace_enable(false);}
uint8_t bb_capture_pending_events(void){return pending_events;}
static void note_events(bool armed,uint8_t mode,uint8_t failsafe,bool rx_fresh,const bb_capture_ctx_t *ctx){
 const uint8_t loop_code=ctx?ctx->loop_code:0u;const bool telem_failed=ctx&&ctx->telem_capture_failed;
 if(have_state){
  uint8_t e=0;
  if(armed&&!last.armed)e|=BB_EVENT_ARM;
  if(!armed&&last.armed)e|=BB_EVENT_DISARM;
  if(failsafe!=last.failsafe)e|=BB_EVENT_FAILSAFE_STAGE;
  if(!rx_fresh&&last.rx_fresh)e|=BB_EVENT_RX_LOST;
  if(mode!=last.mode)e|=BB_EVENT_MODE;
  if(loop_code!=last.loop_code)e|=BB_EVENT_LOOP_RATE;
  if(telem_failed&&!last.telem_failed)e|=BB_EVENT_TELEM_CAPTURE_FAIL;
  pending_events|=e;
 }
 /* The first loop of a session is the baseline: no transition is invented. */
 last.armed=armed;last.mode=mode;last.failsafe=failsafe;last.rx_fresh=rx_fresh;last.loop_code=loop_code;last.telem_failed=telem_failed;have_state=true;
}
void bb_capture_observe_ex(uint64_t now,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy,
 const bb_capture_ctx_t *ctx){
 if(!recorder_active())return;
 /* Preserve queued records on clock/session failure; never wrap timestamps. */
 if(now<epoch||now-epoch>UINT32_MAX||(have_previous&&now<=previous)||iteration==UINT32_MAX){bb_capture_end();return;}
 if(!raw||!filtered||!setpoint||!output||!motors){bb_capture_end();return;}
 const uint32_t it=iteration++,time_us=(uint32_t)(now-epoch),dt_us=have_previous?(uint32_t)(now-previous):0;
 previous=now;have_previous=true;
 const bool fresh=rx_fresh&&rc!=NULL;
 note_events(armed,mode,failsafe,fresh,ctx);
 if(ctx&&!have_overruns){overruns_base=ctx->overruns_total;have_overruns=true;}
 /* Decimate before building: a skipped loop costs only the counters above. */
 if(recorder_skip_if_not_due(time_us,it))return;
 flight_log_sample_t s={0};pid_trace_t trace;
 s.iteration=it;s.time_us=time_us;s.dt_us=dt_us;
 memcpy(s.gyro_raw,raw,sizeof s.gyro_raw);memcpy(s.gyro,filtered,sizeof s.gyro);
 memcpy(s.setpoint,setpoint,sizeof s.setpoint);memcpy(s.motor,motors,sizeof s.motor);
 if(rc)memcpy(s.rc,rc,sizeof s.rc);
 s.setpoint_throttle=ctx&&ctx->mixer_throttle_valid?ctx->mixer_throttle:(rc?rc[3]:0.f);
 s.armed=armed;s.mode=mode;s.failsafe=failsafe;
 s.pid_valid=pid_trace_read(&trace);
 if(s.pid_valid){memcpy(s.p,trace.p,sizeof s.p);memcpy(s.i,trace.i,sizeof s.i);memcpy(s.d,trace.d,sizeof s.d);}
 s.pid_output[0]=output->roll;s.pid_output[1]=output->pitch;s.pid_output[2]=output->yaw;
 s.gyro_valid=gyro_valid;s.rx_fresh=fresh;s.output_healthy=output_healthy;
 if(ctx){
  if(ctx->fill){bb_capture_extra_t x;memset(&x,0,sizeof x);ctx->fill(&x);memcpy(s.erpm,x.erpm,sizeof s.erpm);s.telem_ok=x.telem_ok;s.filter_flags=x.filter_flags;
   memcpy(s.accel_g,x.accel_g,sizeof s.accel_g);memcpy(s.attitude_deg,x.attitude_deg,sizeof s.attitude_deg);
   s.accel_valid=x.accel_valid&&gyro_valid;s.attitude_valid=x.attitude_valid&&gyro_valid;
   memcpy(s.rssi_dbm,x.rssi_dbm,sizeof s.rssi_dbm);s.link_valid=x.link_valid;s.link_lq=x.link_lq;s.link_snr=x.link_snr;s.link_antenna=x.link_antenna;s.link_rf_mode=x.link_rf_mode;s.link_age_ms=x.link_age_ms;
   s.baro_pressure_pa=x.baro_pressure_pa;s.baro_temp_c=x.baro_temp_c;s.baro_alt_cm=x.baro_alt_cm;s.baro_reference_pa=x.baro_reference_pa;s.baro_valid=x.baro_valid;s.baro_alt_valid=x.baro_alt_valid;s.baro_age_ms=x.baro_age_ms;s.baro_sample=x.baro_sample;}
  s.loop_code=ctx->loop_code;s.overruns=ctx->overruns_total-overruns_base;
 }
 s.events=pending_events;
 /* Cleared only once a frame carrying them is in the log queue. */
 if(recorder_capture(&s))pending_events=0;
}
void bb_capture_observe(uint64_t now,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy){
 bb_capture_observe_ex(now,raw,filtered,setpoint,output,motors,rc,armed,mode,failsafe,gyro_valid,rx_fresh,output_healthy,NULL);
}
