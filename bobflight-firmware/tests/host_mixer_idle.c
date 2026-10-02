/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: min_throttle floors stick throttle and post-mix motors while
 * the mixer runs (armed path). ARMING_THROTTLE_MAX is independent. Not flight-qualified.
 * Safety S1: desaturation rule (mixer.c / docs/SAFETY-NOISE.md) and the
 * saturation flag handed to the PID for I-term anti-windup.
 */
#include "flight/mixer.h"
#include "flight/config.h"
#include "flight/pid.h"
#include <math.h>
#include <stdio.h>

static int fail(const char *m){fprintf(stderr,"FAIL host_mixer_idle: %s\n",m);return 1;}
static int near(float a,float b){return fabsf(a-b)<1e-5f;}
/* mixer.c reports saturation to the PID; capture it here (pid.c not linked). */
static int sat_calls; static bool sat_flag;
void pid_set_mixer_saturated(bool s){sat_calls++;sat_flag=s;}
static float mean4(const float m[4]){return (m[0]+m[1]+m[2]+m[3])/4.f;}
/* QUADX differential part of motor i for a PID output. */
static void mix_u(const pid_axis_out_t *p,float u[4]){
    u[0]=-p->roll+p->pitch-p->yaw;u[1]=-p->roll-p->pitch+p->yaw;u[2]=p->roll+p->pitch+p->yaw;u[3]=p->roll-p->pitch-p->yaw;
}
/* motors == level + s*u for one s; returns s (or -1 if not of that shape). */
static float shape_scale(const pid_axis_out_t *p,const float m[4],float level){
    float u[4];mix_u(p,u);float uu=0,mu=0;
    for(int i=0;i<4;i++){uu+=u[i]*u[i];mu+=(m[i]-level)*u[i];}
    const float s=uu>0?mu/uu:1.f;
    for(int i=0;i<4;i++)if(fabsf(m[i]-level-s*u[i])>1e-5f)return -1.f;
    return s;
}
static int desat_rule(void)
{
    float m[4];pid_axis_out_t p;
    if (!config_set_key("min_throttle", 0.05f)) return fail("set mt 0.05");
    /* No saturation: passthrough, flag clear. */
    p=(pid_axis_out_t){0.03f,-0.02f,0.01f};sat_calls=0;
    mixer_update(&p,0.5f,m);
    if(sat_calls!=1||sat_flag||!near(shape_scale(&p,m,0.5f),1.f)) return fail("unsaturated passthrough");
    /* Low side (thr 0.10, roll 0.2 asks 0.10-0.2 < 0.05): uniform scale
     * (0.10-0.05)/0.2 = 0.25, mean stays 0.10, lowest motor exactly at mt,
     * roll:pitch:yaw ratio kept, flag set. */
    p=(pid_axis_out_t){0.2f,0.1f,-0.04f};
    mixer_update(&p,0.10f,m);
    float u[4];mix_u(&p,u);float umin=u[0];for(int i=1;i<4;i++)if(u[i]<umin)umin=u[i];
    const float s_low=(0.10f-0.05f)/-umin;
    if(!near(mean4(m),0.10f)) return fail("low side: mean == commanded throttle");
    if(!near(shape_scale(&p,m,0.10f),s_low)) return fail("low side: uniform scale (thr-mt)/-umin");
    if(!sat_flag) return fail("low side: saturated flag");
    {float lo=m[0];for(int i=1;i<4;i++)if(m[i]<lo)lo=m[i];if(!near(lo,0.05f)) return fail("low side: lowest motor at min_throttle");}
    /* Spread wider than the motor range: scale by (1-mt)/span first. */
    p=(pid_axis_out_t){0.4f,0.4f,0.2f};
    mixer_update(&p,0.5f,m);
    mix_u(&p,u);float lo=u[0],hi=u[0];for(int i=1;i<4;i++){if(u[i]<lo)lo=u[i];if(u[i]>hi)hi=u[i];}
    float s=(1.f-0.05f)/(hi-lo);if(0.5f+s*lo<0.05f)s=(0.5f-0.05f)/-lo;
    float sh=0.f;if(0.5f+s*hi>1.f)sh=1.f-(0.5f+s*hi);
    if(!near(shape_scale(&p,m,0.5f+sh),s)||!sat_flag) return fail("span: scale to fit");
    for(int i=0;i<4;i++)if(m[i]<0.05f-1e-6f||m[i]>1.f+1e-6f) return fail("span: in range");
    /* High side (thr 0.9, roll 0.2): full differential kept, all four
     * shifted down by 0.1; mean 0.8 < commanded; not saturated (no scale). */
    p=(pid_axis_out_t){0.2f,0.f,0.f};
    mixer_update(&p,0.9f,m);
    if(!near(shape_scale(&p,m,0.8f),1.f)) return fail("high side: full authority, shifted down");
    if(!near(mean4(m),0.8f)||sat_flag) return fail("high side: mean lowered, no I freeze");
    /* Mean never above commanded throttle with airmode off (default). */
    for(float r=-0.4f;r<=0.4f;r+=0.05f)for(float t=0.05f;t<=1.f;t+=0.05f){
        p=(pid_axis_out_t){r,0.5f*r,-0.3f*r};mixer_update(&p,t,m);
        if(mean4(m)>t+1e-5f) return fail("mean above commanded throttle");
        for(int i=0;i<4;i++)if(m[i]<0.05f-1e-6f||m[i]>1.f+1e-6f) return fail("motor out of [mt,1]");
        if(shape_scale(&p,m,mean4(m))<0.f) return fail("hard clipping (shape lost)");
    }
    /* Airmode on (user setting): low side shifted UP instead, full authority. */
    if (!config_set_key("airmode", 1.f)) return fail("set airmode");
    p=(pid_axis_out_t){0.2f,0.f,0.f};
    mixer_update(&p,0.10f,m);
    if(!near(shape_scale(&p,m,0.25f),1.f)||sat_flag) return fail("airmode: shift up keeps authority");
    if (!config_set_key("airmode", 0.f)) return fail("clear airmode");
    /* At the idle floor with airmode off the PID part is scaled to zero. */
    p=(pid_axis_out_t){0.2f,0.f,0.f};
    mixer_update(&p,0.f,m);
    for(int i=0;i<4;i++)if(!near(m[i],0.05f)) return fail("idle floor: no throttle raise without airmode");
    return 0;
}

/* Boundary tests (QA N1, mutations M23 top bound 1.0 -> 1.01 and M24 spread
 * threshold 1 - mt -> 1): exactly at, just below and just above each bound.
 * Roll r + pitch q gives u = (-r+q, -r-q, r+q, r-q): umax = r+q, span =
 * 2(r+q), four different motor levels, so a clamp of one motor changes the
 * shape (pure roll would clamp two motors symmetrically and hide it). */
static int roll_case(float mt,float thr,float r,float q,float want_s,float want_level,bool want_sat,const char *what)
{
    float m[4];pid_axis_out_t p={r,q,0.f};
    if(!config_set_key("min_throttle",mt)) return fail("boundary: set mt");
    mixer_update(&p,thr,m);
    const float s=shape_scale(&p,m,want_level);
    if(s<0.f||fabsf(s-want_s)>1e-5f){fprintf(stderr,"%s: s=%g want %g m=%g %g %g %g\n",what,(double)s,(double)want_s,(double)m[0],(double)m[1],(double)m[2],(double)m[3]);return fail(what);}
    if(sat_flag!=want_sat){fprintf(stderr,"%s: sat=%d\n",what,sat_flag);return fail(what);}
    for(int i=0;i<4;i++)if(m[i]<mt-1e-6f||m[i]>1.f+1e-6f) return fail(what);
    return 0;
}
static int boundary_rules(void)
{
    /* Top bound (step 3, thr + umax > 1), mt 0.05, thr 0.75. */
    if(roll_case(0.05f,0.75f,0.25f,0.f, 1.f,0.75f,false,"top bound exactly at 1.0: no shift, highest motor == 1")) return 1;
    if(roll_case(0.05f,0.75f,0.249f,0.f,1.f,0.75f,false,"top bound just below (0.999): no shift")) return 1;
    if(roll_case(0.05f,0.75f,0.251f,0.f,1.f,0.749f,false,"top bound just above (1.001): shift down 0.001, full differential")) return 1;
    {float m[4];pid_axis_out_t p={0.251f,0.f,0.f};mixer_update(&p,0.75f,m);
     if(!near(m[2],1.f)||!near(m[3],1.f)||!near(mean4(m),0.749f)) return fail("top bound just above: highest motors exactly 1, mean 0.749");}
    /* Spread threshold (step 1, span > 1 - mt), mt 0.125 so 1 - mt = 0.875 exactly. */
    if(roll_case(0.125f,0.5625f,0.3125f,0.125f,1.f,0.5625f,false,"spread exactly 1-mt (0.875): no scale, motors span [mt,1]")) return 1;
    if(roll_case(0.125f,0.5625f,0.312f, 0.125f,1.f,0.5625f,false,"spread just below 1-mt (0.874): no scale")) return 1;
    /* Just above (0.876) at thr 0.6: scale 0.875/0.876, then shift down so the
     * motors span exactly [0.125, 1]. Without step 1 (threshold 1) the shift
     * would push the low motors to 0.124 and clip them. */
    {const float s=0.875f/0.876f,lvl=1.f-s*0.438f;
     if(roll_case(0.125f,0.6f,0.313f,0.125f,s,lvl,true,"spread just above 1-mt (0.876): scale (1-mt)/span, then shift")) return 1;
     float m[4];pid_axis_out_t p={0.313f,0.125f,0.f};mixer_update(&p,0.6f,m);
     if(!near(m[1],0.125f)||!near(m[2],1.f)) return fail("spread just above: lowest motor exactly at mt, highest at 1");}
    if(!config_set_key("min_throttle",0.05f)) return fail("boundary: restore mt");
    return 0;
}

int main(void)
{
    float motors[MIXER_MOTOR_COUNT];
    pid_axis_out_t pid = {0.f, 0.f, 0.f};

    config_init();
    mixer_init();

    /* Default min_throttle 0.05: zero stick → all motors at idle floor. */
    mixer_update(&pid, 0.f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.05f)) {
            fprintf(stderr, "m%d=%g\n", i, (double)motors[i]);
            return fail("default idle floor 0.05");
        }
    }

    /* Stick above floor unchanged in common mode. */
    mixer_update(&pid, 0.4f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.4f)) return fail("thr 0.4 passthrough");
    }

    /* min_throttle 0: allow true zero (bench / props-off). */
    if (!config_set_key("min_throttle", 0.f)) return fail("set mt 0");
    mixer_update(&pid, 0.f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.f)) return fail("mt0 allows zero");
    }

    /* Post-mix floor: PID that would drive a motor below idle. */
    if (!config_set_key("min_throttle", 0.08f)) return fail("set mt 0.08");
    pid.roll = 0.2f;
    mixer_update(&pid, 0.1f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (motors[i] + 1e-6f < 0.08f) {
            fprintf(stderr, "m%d=%g below floor\n", i, (double)motors[i]);
            return fail("post-mix floor");
        }
    }

    if (desat_rule()) return 1;
    if (boundary_rules()) return 1;

    /* Range reject */
    if (config_set_key("min_throttle", 0.25f)) return fail("mt>0.2 should fail");
    if (config_set_key("min_throttle", -0.01f)) return fail("mt<0 should fail");

    puts("PASS host_mixer_idle: min_throttle stick+post-mix floor; S1 desaturation (low-side scale, span scale, high-side shift, mean <= commanded, shape kept, airmode shift-up only when enabled) + saturation flag; top-bound and spread-threshold boundaries (at / just below / just above)");
    return 0;
}
