/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Safety S1 PID unit checks (docs/SAFETY-NOISE.md):
 *  - mixer-saturation anti-windup: while pid_set_mixer_saturated(true) the
 *    I accumulator never grows in magnitude (it may shrink); pid_init clears it;
 *  - second-order D-term LPF: off by default; when on, still -3 dB at
 *    dterm_lpf_hz (stage scale 1.5538) and 1.8x / 2.6x quieter than the
 *    first-order filter at 200 / 300 Hz. Measured on the real pid_update at
 *    the 4 kHz PID rate. */
#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>
#include <stdio.h>
static int fail(const char *m){fprintf(stderr,"FAIL host_pid_s1: %s\n",m);return 1;}
static float i_after(int n,float err){
    pid_axis_out_t o;const float g[3]={0,0,0};const float sp[3]={err,0,0};
    for(int k=0;k<n;k++)pid_update(g,sp,&o);
    pid_trace_t t;pid_trace_enable(true);pid_update(g,(const float[3]){0,0,0},&o);
    const bool ok=pid_trace_read(&t);pid_trace_enable(false);
    return ok?t.i[0]:NAN;
}
/* Peak D term (kd = 1) for a 10 dps gyro sine at f, after settling. */
static float d_peak(float f){
    pid_init();pid_axis_out_t o;const float sp[3]={0,0,0};float peak=0;
    pid_trace_enable(true);
    for(int k=0;k<8000;k++){
        const float t=(float)k/4000.f,g[3]={10.f*sinf(6.2831853f*f*t),0,0};
        pid_update(g,sp,&o);pid_trace_t tr;
        if(k>4000&&pid_trace_read(&tr)&&fabsf(tr.d[0])>peak)peak=fabsf(tr.d[0]);
    }
    pid_trace_enable(false);return peak;
}
int main(void){
    config_init();
    if(!config_set_key("pid_roll_p",0.f)||!config_set_key("pid_roll_i",0.001f)||!config_set_key("pid_roll_d",0.f))return fail("gains");
    pid_init();pid_set_dt(0.00025f);
    /* Free: 10 dps for 400 cycles -> accumulator 1.0 -> I term 0.001. */
    const float free1=i_after(400,10.f);
    if(!(fabsf(free1-0.001f)<0.00002f))return fail("unsaturated I integrates");
    pid_set_mixer_saturated(true);
    const float frozen=i_after(400,10.f);
    if(!(fabsf(frozen-free1)<1e-9f))return fail("saturated: I must not grow");
    const float shrunk=i_after(200,-10.f);
    if(!(shrunk<frozen-0.0004f))return fail("saturated: I may shrink toward zero");
    const float no_cross=i_after(400,-10.f);
    if(!(fabsf(no_cross)<=fabsf(shrunk)+1e-9f))return fail("saturated: I must not grow past zero the other way");
    pid_set_mixer_saturated(false);
    if(!(i_after(100,10.f)>no_cross))return fail("cleared: I integrates again");
    pid_set_mixer_saturated(true);pid_init();
    if(!(i_after(100,10.f)>0.f))return fail("pid_init clears the saturation flag");
    /* D-term LPF order. */
    if(pid_dterm_lpf_pt2())return fail("second-order D LPF must be off by default");
    if(!config_set_key("pid_roll_i",0.f)||!config_set_key("pid_roll_d",1.f))return fail("gains d");
    pid_set_dt(0.00025f);
    const float ideal53=10.f*6.2831853f*53.f;
    const float pt1_53=d_peak(53.f),pt1_200=d_peak(200.f),pt1_300=d_peak(300.f);
    pid_set_dterm_lpf_pt2(true);
    if(!pid_dterm_lpf_pt2())return fail("pt2 getter");
    const float pt2_53=d_peak(53.f),pt2_200=d_peak(200.f),pt2_300=d_peak(300.f);
    pid_set_dterm_lpf_pt2(false);
    printf("D gain / ideal at 53 Hz: PT1 %.3f PT2 %.3f; PT2/PT1 at 200 Hz %.3f, 300 Hz %.3f\n",
           pt1_53/ideal53,pt2_53/ideal53,pt2_200/pt1_200,pt2_300/pt1_300);
    if(!(fabsf(pt1_53/ideal53-0.707f)<0.03f))return fail("PT1 -3 dB at dterm_lpf_hz");
    if(!(fabsf(pt2_53/pt1_53-1.f)<0.04f))return fail("PT2 still -3 dB at dterm_lpf_hz (same gain as PT1 there)");
    if(!(pt2_200/pt1_200<0.62f&&pt2_300/pt1_300<0.45f))return fail("PT2 quieter at 200/300 Hz");
    puts("PASS host_pid_s1: I frozen (may shrink) while mixer saturated, cleared by pid_init; D-term PT2 off by default, -3 dB at dterm_lpf_hz, quieter at 200/300 Hz");
    return 0;
}
