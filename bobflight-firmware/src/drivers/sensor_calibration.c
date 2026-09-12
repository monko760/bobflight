/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0.
 * Original six-face diagonal offset/scale solve and Welford stationary windows.
 * No HAL, allocation, delay, flash, or assumption about a particular board pose.
 */
#include "drivers/sensor_calibration.h"
#include <math.h>
#include <string.h>

static void window_reset(sensor_calibration_t *c) {
    c->samples=0;
    memset(c->mean,0,sizeof(c->mean));memset(c->m2,0,sizeof(c->m2));
}
void sc_init(sensor_calibration_t *c) {
    memset(c,0,sizeof(*c));c->face=-1;c->reason="idle";
    for(unsigned i=0;i<3;i++)c->accel_scale[i]=1.f;
}
void sc_cancel(sensor_calibration_t *c,const char *reason) {
    c->mode=SC_IDLE;c->reason=reason;c->faces=0;c->face=-1;
    c->have_last=false;window_reset(c); /* applied coefficients are untouched */
}
static void begin(sensor_calibration_t *c,sc_mode_t mode,uint32_t now) {
    c->mode=mode;c->phase_started=c->session_started=now;c->have_last=false;
    c->faces=0;c->face=-1;window_reset(c);
}
void sc_begin_gyro(sensor_calibration_t *c,uint32_t now) {
    begin(c,SC_GYRO,now);c->reason="keep-still";
}
void sc_begin_accel(sensor_calibration_t *c,uint32_t now) {
    begin(c,SC_ACCEL_WAIT,now);memset(c->face_mean,0,sizeof(c->face_mean));
    c->reason="select-face";
}
bool sc_capture_face(sensor_calibration_t *c,unsigned face,uint32_t now) {
    sc_tick(c,now);
    if(c->mode!=SC_ACCEL_WAIT || face>=6)return false;
    c->mode=SC_ACCEL_COLLECT;c->face=(int)face;c->faces&=~(1u<<face);
    c->phase_started=now;c->have_last=false;window_reset(c);
    c->reason="hold-selected-signed-axis-up";return true;
}
void sc_tick(sensor_calibration_t *c,uint32_t now) {
    bool collecting=c->mode==SC_GYRO || c->mode==SC_ACCEL_COLLECT;
    bool accel=c->mode==SC_ACCEL_WAIT || c->mode==SC_ACCEL_COLLECT;
    if((collecting && (uint32_t)(now-c->phase_started)>=30000u) ||
       (accel && (uint32_t)(now-c->session_started)>=300000u)) {
        c->mode=SC_ERROR;c->reason="timeout";window_reset(c);
    }
}
void sc_correct_accel(const sensor_calibration_t *c,const float in[3],float out[3]) {
    for(unsigned i=0;i<3;i++)out[i]=(in[i]-c->accel_bias[i])*c->accel_scale[i];
}
const char *sc_state_name(const sensor_calibration_t *c) {
    switch(c->mode) {
    case SC_GYRO:return "gyro";case SC_ACCEL_WAIT:return "accel_wait";
    case SC_ACCEL_COLLECT:return "accel_collect";case SC_COMPLETE:return "complete";
    case SC_ERROR:return "error";default:return "idle";
    }
}
unsigned sc_required(const sensor_calibration_t *c) {
    return c->mode==SC_GYRO?1000u:c->mode==SC_ACCEL_COLLECT?500u:0u;
}
void sc_feed(sensor_calibration_t *c,const float gyro[3],const float raw_acc[3],uint32_t now) {
    sc_tick(c,now);
    if(c->mode!=SC_GYRO && c->mode!=SC_ACCEL_COLLECT)return;
    for(unsigned i=0;i<3;i++)if(!isfinite(gyro[i]) || !isfinite(raw_acc[i])) {
        c->mode=SC_ERROR;c->reason="nonfinite-sample";window_reset(c);return;
    }
    if(c->have_last && now==c->last_ms)return; /* repeated reads cannot speed up calibration */
    if(c->have_last && (uint32_t)(now-c->last_ms)>20u)window_reset(c);
    c->have_last=true;c->last_ms=now;
    float acc[3];
    if(c->mode==SC_GYRO)sc_correct_accel(c,raw_acc,acc);
    else memcpy(acc,raw_acc,sizeof(acc));
    float norm=acc[0]*acc[0]+acc[1]*acc[1]+acc[2]*acc[2];
    if(norm<0.81f || norm>1.21f) {
        window_reset(c);c->reason="invalid-gravity-expected-0.9-to-1.1g";return;
    }
    for(unsigned i=0;i<3;i++)if(fabsf(gyro[i])>5.f) {
        window_reset(c);c->reason="moving";return;
    }
    if(c->mode==SC_ACCEL_COLLECT) {
        unsigned axis=(unsigned)c->face/2u;
        float sign=(c->face&1)?-1.f:1.f;
        if(sign*acc[axis]<0.85f || fabsf(acc[(axis+1u)%3u])>0.15f || fabsf(acc[(axis+2u)%3u])>0.15f) {
            window_reset(c);c->reason="wrong-face-or-not-square";return;
        }
    }
    if(c->samples==0)c->window_started=now;
    ++c->samples;
    for(unsigned i=0;i<6;i++) {
        float x=i<3?gyro[i]:acc[i-3u];
        float delta=x-c->mean[i];c->mean[i]+=delta/(float)c->samples;
        c->m2[i]+=delta*(x-c->mean[i]);
    }
    c->reason="collecting";
    unsigned required=sc_required(c);
    if(c->samples<required || (uint32_t)(now-c->window_started)<required)return;
    for(unsigned i=0;i<6;i++) {
        float limit=i<3?0.04f:0.0004f;
        if(c->m2[i]/(float)c->samples>limit) {
            window_reset(c);c->reason="noisy-or-moving";return;
        }
    }
    if(c->mode==SC_GYRO) {
        memcpy(c->gyro_bias,c->mean,sizeof(c->gyro_bias));c->gyro_valid=true;
        c->mode=SC_COMPLETE;c->reason="gyro-calibrated-ram-only";
    } else {
        memcpy(c->face_mean[c->face],c->mean+3,3*sizeof(float));
        c->faces|=1u<<(unsigned)c->face;c->mode=SC_ACCEL_WAIT;
        c->reason=c->faces==63u?"all-faces-ready-to-apply":"face-captured-select-next";
    }
}
bool sc_apply_accel(sensor_calibration_t *c) {
    if(c->mode!=SC_ACCEL_WAIT || c->faces!=63u) {c->reason="six-faces-required";return false;}
    float bias[3],scale[3];
    for(unsigned i=0;i<3;i++) {
        float plus=c->face_mean[2u*i][i],minus=c->face_mean[2u*i+1u][i];
        bias[i]=(plus+minus)*0.5f;scale[i]=2.f/(plus-minus);
        if(!isfinite(bias[i]) || !isfinite(scale[i]) || fabsf(bias[i])>0.1f || scale[i]<0.9f || scale[i]>1.1f) {
            c->reason="implausible-coefficients-check-sensor";return false;
        }
    }
    for(unsigned face=0;face<6;face++)for(unsigned axis=0;axis<3;axis++) {
        float expected=axis==face/2u?((face&1u)?-1.f:1.f):0.f;
        float corrected=(c->face_mean[face][axis]-bias[axis])*scale[axis];
        if(!isfinite(corrected) || fabsf(corrected-expected)>0.1f) {
            c->reason="pose-residual-too-large-recapture";return false;
        }
    }
    memcpy(c->accel_bias,bias,sizeof(bias));memcpy(c->accel_scale,scale,sizeof(scale));
    c->accel_valid=true;c->mode=SC_COMPLETE;c->reason="accel-calibrated-ram-only";
    return true;
}
