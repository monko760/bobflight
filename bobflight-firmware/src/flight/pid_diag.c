/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "flight/pid_diag.h"
#include "flight/pid.h"
#include "flight/config.h"
#include "flight/rates.h"
#include "flight/arming.h"
#include "drivers/gyro.h"
#include "drivers/rx.h"
#include "sched/tasks.h"
#include "hal/hal.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

void pid_diag_core_reset(void);
void pid_diag_core_dt(float dt);
void pid_diag_core_update(const float gyro[3],const float setpoint[3],pid_axis_out_t *out);
static pid_diag_snapshot_t s={.version=1,.reason="inactive",.sample_age_us=-1};
static uint64_t last_update,last_frame;
static uint32_t started,last_sensor_seq;
static bool have_time;

static void reset_values(const char *reason,bool stop){
    if(stop)s.active=false;
    s.valid=false;s.reason=reason;s.sample_age_us=-1;s.dt_us=0;
    memset(s.setpoint_dps,0,sizeof(s.setpoint_dps));
    memset(s.gyro_dps,0,sizeof(s.gyro_dps));
    memset(s.error_dps,0,sizeof(s.error_dps));
    memset(s.correction,0,sizeof(s.correction));
    have_time=false;s.reset_count++;pid_diag_core_reset();
}
void pid_diag_init(void){
    memset(&s,0,sizeof(s));s.version=1;s.reason="inactive";s.sample_age_us=-1;
    have_time=false;last_update=last_frame=0;started=last_sensor_seq=0;
    pid_diag_core_reset();
}
bool pid_diag_is_active(void){return s.active;}
void pid_diag_stop(const char *reason){reset_values(reason?reason:"explicit-stop",true);}
static bool finite3(const float *v){return v&&isfinite(v[0])&&isfinite(v[1])&&isfinite(v[2]);}
static const char *guards(pid_diag_source_t source){
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    (void)source;return "flight-build-refused";
#else
    if(arming_state()==ARM_ARMED)return "armed";
    if(!hal_usb_cdc_connected())return "usb-disconnected";
    if(bench_motor_active())return "bench-motor-active";
    if(gyro_manual_calibration_active())return "manual-calibration";
    if(!gyro_is_healthy())return "gyro-unhealthy";
    if(!gyro_calibrated())return "gyro-uncalibrated";
    const gyro_diagnostics_t *d=gyro_diagnostics();
    if(!d || !d->config_ok || (uint32_t)(hal_millis()-d->sample_ms)>20u)return "gyro-stale";
    if(source==PID_DIAG_SOURCE_RX){
        if(!rx_frame_fresh())return "receiver-stale";
        const float *rc=rx_channels();
        if(!finite3(rc)||!isfinite(rc[3])||fabsf(rc[0])>1.f||fabsf(rc[1])>1.f||fabsf(rc[2])>1.f||rc[3]<0.f||rc[3]>1.f)return "receiver-invalid";
    }
    return NULL;
#endif
}
static const char *session_guard(void){
    if((uint32_t)(hal_millis()-started)>=60000u)return "session-expired";
    return guards(s.source);
}
bool pid_diag_start(pid_diag_source_t source,const char **err){
    const char *why=(source!=PID_DIAG_SOURCE_ZERO&&source!=PID_DIAG_SOURCE_RX)?"invalid-source":guards(source);
    if(why){pid_diag_stop(why);if(err)*err=why;return false;}
    pid_diag_init();s.active=true;s.source=source;s.reason="priming";started=hal_millis();
    if(err)*err=NULL;
    return true;
}
void pid_diag_update(uint64_t now,const float gyro[3]){
    if(!s.active)return;
    const char *why=session_guard();
    if(why){pid_diag_stop(why);return;}
    if(!finite3(gyro)){reset_values("gyro-nonfinite",false);return;}
    const gyro_diagnostics_t *d=gyro_diagnostics();
    if(!have_time){last_update=now;last_sensor_seq=d->sample_seq;have_time=true;s.reason="priming";return;}
    uint64_t elapsed=now>last_update?now-last_update:0;
    if(!elapsed||elapsed>=20000u){reset_values("dt-invalid",false);return;}
    if(d->sample_seq==last_sensor_seq){reset_values("gyro-no-new-sample",false);return;}
    float demand[3]={0};
    if(s.source==PID_DIAG_SOURCE_RX)rates_update(rx_channels(),demand);
    const bf_config_t *cfg=config_get();
    if(!cfg||!finite3(demand)||!isfinite(cfg->pid_roll_p)||!isfinite(cfg->pid_roll_i)||!isfinite(cfg->pid_roll_d)||!isfinite(cfg->pid_pitch_p)||!isfinite(cfg->pid_pitch_i)||!isfinite(cfg->pid_pitch_d)||!isfinite(cfg->pid_yaw_p)||!isfinite(cfg->pid_yaw_i)){
        reset_values("config-invalid",false);return;
    }
    for(unsigned i=0;i<3;i++)if(!isfinite(demand[i]-gyro[i])){reset_values("error-nonfinite",false);return;}
    pid_axis_out_t out={0};
    pid_diag_core_dt((float)elapsed*0.000001f);
    pid_diag_core_update(gyro,demand,&out);
    float correction[3]={out.roll,out.pitch,out.yaw};
    if(!finite3(correction)){reset_values("pid-nonfinite",false);return;}
    memcpy(s.setpoint_dps,demand,sizeof(demand));memcpy(s.gyro_dps,gyro,sizeof(s.gyro_dps));
    memcpy(s.correction,correction,sizeof(correction));
    for(unsigned i=0;i<3;i++)s.error_dps[i]=demand[i]-gyro[i];
    s.dt_us=(uint32_t)elapsed;s.sample_seq++;s.valid=true;s.reason="running";
    last_update=last_frame=now;last_sensor_seq=d->sample_seq;
}
void pid_diag_get_snapshot(pid_diag_snapshot_t *out){
    if(!out)return;
    uint64_t now=hal_micros();
    if(s.active){
        const char *why=session_guard();
        if(why)pid_diag_stop(why);
        else if(s.valid&&(now<last_frame||now-last_frame>=20000u))reset_values("diagnostic-stale",false);
    }
    *out=s;out->session_age_ms=s.active?(uint32_t)(hal_millis()-started):0;
    out->sample_age_us=s.valid?(int64_t)(now-last_frame):-1;
}
void pid_diag_cli_process(const char *cmd,char *buf,size_t size){
    if(!buf||!size)return;
    bool ok=true;
    if(cmd&&(!strcmp(cmd,"pid_diag")||!strcmp(cmd,"pid_diag status"))){}
    else if(cmd&&!strcmp(cmd,"pid_diag start"))pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL);
    else if(cmd&&!strcmp(cmd,"pid_diag start rx"))pid_diag_start(PID_DIAG_SOURCE_RX,NULL);
    else if(cmd&&!strcmp(cmd,"pid_diag stop"))pid_diag_stop("explicit-stop");
    else ok=false;
    if(!ok){snprintf(buf,size,"pid_diag refused: invalid-command\r\npid_diag_end: 1\r\n");return;}
    pid_diag_snapshot_t p;pid_diag_get_snapshot(&p);
    snprintf(buf,size,
        "pid_diag_version: 1\r\nactive: %s\r\nvalid: %s\r\nreason: %s\r\nsource: %s\r\nmode: acro\r\n"
        "sample_seq: %lu\r\nsample_age_us: %lld\r\ndt_us: %lu\r\n"
        "setpoint_dps: %.3f %.3f %.3f\r\ngyro_dps: %.3f %.3f %.3f\r\nerror_dps: %.3f %.3f %.3f\r\n"
        "correction: %.6f %.6f %.6f\r\nmotor_output: disabled\r\nresets: %lu\r\nsession_age_ms: %lu\r\npid_diag_end: 1\r\n",
        p.active?"yes":"no",p.valid?"yes":"no",p.reason,p.source==PID_DIAG_SOURCE_RX?"rx":"zero",
        (unsigned long)p.sample_seq,(long long)p.sample_age_us,(unsigned long)p.dt_us,
        (double)p.setpoint_dps[0],(double)p.setpoint_dps[1],(double)p.setpoint_dps[2],
        (double)p.gyro_dps[0],(double)p.gyro_dps[1],(double)p.gyro_dps[2],
        (double)p.error_dps[0],(double)p.error_dps[1],(double)p.error_dps[2],
        (double)p.correction[0],(double)p.correction[1],(double)p.correction[2],
        (unsigned long)p.reset_count,(unsigned long)p.session_age_ms);
}
