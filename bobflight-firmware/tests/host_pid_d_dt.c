/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * D-term time base (real pid.c + filter.c + config.c).
 *  - Without a floor (legacy) a PID run 213 us after the previous one at a
 *    1 ms nominal period scales raw D by 1000/213 = 4.69x.
 *  - With the floor at the nominal period the same run gives exactly the
 *    nominal D; long intervals (skipped slot) still use the measured dt.
 *  - I keeps integrating with the measured dt in every case.
 *  - Invalid floors (0, negative, >= 20 ms, NaN) disable the floor. */
#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>
#include <stdio.h>
static int fail(const char *m){fprintf(stderr,"host_pid_d_dt FAIL: %s\n",m);return 1;}
/* Two updates; gyro roll steps 0 -> step between them. Returns traced D. */
static float d_for(float floor_s,float dt_s,float step,float *i_out){
    pid_trace_t t;pid_axis_out_t o;const float sp[3]={0,0,0};float g[3]={0,0,0};
    pid_init();pid_trace_enable(true);pid_set_d_dt_floor(floor_s);
    pid_set_dt(0.001f);pid_update(g,sp,&o);
    g[0]=step;pid_set_dt(dt_s);pid_update(g,sp,&o);
    if(!pid_trace_read(&t))return NAN;
    if(i_out)*i_out=t.i[0];
    pid_trace_enable(false);return t.d[0];
}
int main(void){
    config_defaults();
    if(!config_set_key("dterm_lpf_hz",0.f))return fail("D low-pass off for a raw D reading");
    if(!config_set_key("pid_roll_d",0.0001f)||!config_set_key("pid_roll_i",0.01f))return fail("gains");
    const float step=1.f,kd=0.0001f,ki=0.01f;
    float i_short,i_nom;
    const float nominal=d_for(0.001f,0.001f,step,&i_nom);   /* -kd*step/1ms = -0.1 */
    const float legacy =d_for(0.f,   0.000213f,step,NULL);
    const float fixed  =d_for(0.001f,0.000213f,step,&i_short);
    const float longdt =d_for(0.001f,0.002f,step,NULL);
    printf("D for a 1 dps step: nominal %.5f, 213 us legacy %.5f (%.2fx), 213 us with floor %.5f, 2 ms %.5f\n",
           nominal,legacy,legacy/nominal,fixed,longdt);
    if(!(fabsf(nominal+kd*step/0.001f)<1e-6f))return fail("nominal D");
    if(!(fabsf(legacy/nominal-1000.f/213.f)<0.01f))return fail("legacy (no floor) reproduces the 4.69x spike");
    if(!(fabsf(fixed-nominal)<1e-6f))return fail("floor: short interval gives nominal D");
    if(!(fabsf(longdt-0.5f*nominal)<1e-6f))return fail("long interval still divides by the measured dt");
    /* I integrates err*dt with the measured interval: err=-1 dps. */
    if(!(fabsf(i_nom-ki*(-1.f*0.001f))<1e-9f))return fail("I at nominal dt");
    if(!(fabsf(i_short-ki*(-1.f*0.000213f))<1e-9f))return fail("I keeps the measured short dt");
    const float bad[]={0.f,-0.001f,0.02f,1.f,NAN,INFINITY};
    for(unsigned k=0;k<sizeof bad/sizeof bad[0];k++){
        const float d=d_for(bad[k],0.000213f,step,NULL);
        if(!(fabsf(d-legacy)<1e-6f))return fail("invalid floor must disable the floor");
    }
    puts("PASS host_pid_d_dt: D divisor floored at the nominal PID period; I and long intervals use measured dt; invalid floor off");
    return 0;
}
