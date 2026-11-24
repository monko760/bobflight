/* SPDX-License-Identifier: Apache-2.0
 * N1: attitude loss never disarms in the air. Actual tasks + attitude + rates +
 * horizon + PID with mock RX/clock/arming/motors, replaying a kinematic truth
 * model: the gyro reports the true body rate and the accelerometer the true
 * body gravity direction (or zero g). Host-only; not flight qualification.
 * Axis indexes are zero-based: roll=0, pitch=1, yaw=2. */
#include "sched/tasks.h"
#include "flight/arming.h"
#include "flight/attitude.h"
#include "flight/config.h"
#include "flight/mode_range.h"
#include "flight/horizon.h"
#include "flight/rates.h"
#include "flight/failsafe.h"
#include "flight/pid.h"
#include "flight/mixer.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/rx.h"
#include "drivers/cli.h"
#include "hal/hal.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static uint64_t now;
static arm_state_t arm=ARM_DISARMED;
static bool gyro_ok=true,override;
static float rc[16],gyro[3],accel[3]={0,0,1},motors[4];
static pid_axis_out_t captured;
static unsigned filter_calls;
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000u);}
bool hal_usb_cdc_connected(void){return true;}
arm_state_t arming_state(void){return arm;}
void arming_disarm(void){arm=ARM_DISARMED;}
bool arming_try_arm(void){return false;}
bool gyro_flight_ready(void){return true;}
void gyro_calibration_tick(void){}
bool gyro_manual_calibration_active(void){return false;}
bool gyro_sample(float out[3]){memcpy(out,gyro,sizeof(gyro));return gyro_ok;}
void gyro_filter(const float in[3],float out[3]){filter_calls++;memcpy(out,in,sizeof(gyro));}
const float *gyro_accel_g(void){return accel;}
bool gyro_calibrated(void){return true;}
const float *rx_channels(void){return rc;}
bool rx_frame_fresh(void){return true;}
void rx_poll(void){}
void cli_poll(void){}
void failsafe_tick(uint32_t t){(void)t;}
bool failsafe_command_override(float s[4]){if(!override)return false;s[0]=s[1]=s[2]=0.f;return true;}
bool dshot_is_healthy(void){return true;}
void dshot_write(const float m[4]){memcpy(motors,m,sizeof(motors));}
void mixer_update(const pid_axis_out_t *p,float t,float out[4]){captured=*p;for(unsigned i=0;i<4;i++)out[i]=t;}

#define CHECK(c) do{if(!(c)){fprintf(stderr,"attitude flip FAIL %d: %s\n",__LINE__,#c);return 1;}}while(0)
static const float rad=0.01745329252f;
/* Truth: body-to-earth quaternion (x fwd, y right, z down), w x y z. */
static float tq[4]={1,0,0,0};
static bool zero_g;
static void truth_level(void){tq[0]=1;tq[1]=tq[2]=tq[3]=0;}
static void truth_down(float d[3]){
    d[0]=2.f*(tq[1]*tq[3]-tq[0]*tq[2]);d[1]=2.f*(tq[0]*tq[1]+tq[2]*tq[3]);d[2]=1.f-2.f*(tq[1]*tq[1]+tq[2]*tq[2]);
}
static void truth_rotate(const float dps[3],float dt){
    float w[3]={dps[0]*rad,dps[1]*rad,dps[2]*rad},n=sqrtf(w[0]*w[0]+w[1]*w[1]+w[2]*w[2]);
    if(n<=0.f)return;
    float c=cosf(.5f*n*dt),s=sinf(.5f*n*dt)/n,x=w[0]*s,y=w[1]*s,z=w[2]*s,a=tq[0],b=tq[1],e=tq[2],f=tq[3];
    tq[0]=a*c-b*x-e*y-f*z;tq[1]=a*x+b*c+e*z-f*y;tq[2]=a*y-b*z+e*c+f*x;tq[3]=a*z+b*y-e*x+f*c;
    float m=sqrtf(tq[0]*tq[0]+tq[1]*tq[1]+tq[2]*tq[2]+tq[3]*tq[3]);for(unsigned i=0;i<4;i++)tq[i]/=m;
}
/* Angle between estimated and true body down vectors, degrees. */
static float tilt_error(void){
    const float *a=attitude_degrees();float t[3],r=a[0]*rad,p=a[1]*rad;truth_down(t);
    float e[3]={-sinf(p),sinf(r)*cosf(p),cosf(r)*cosf(p)};
    float d=e[0]*t[0]+e[1]*t[1]+e[2]*t[2];if(d>1.f)d=1.f;if(d< -1.f)d=-1.f;
    return acosf(d)/rad;
}
/* One 1 ms cascade at the given true body rate. */
static void step(const float dps[3]){
    memcpy(gyro,dps,sizeof gyro);truth_rotate(dps,.001f);
    if(zero_g)accel[0]=accel[1]=accel[2]=0.f;else truth_down(accel);
    now+=1000;loop_gyro();loop_filter();loop_pid();loop_mixer_dshot();
}
static bool prime(control_mode_t mode){
    static const float still[3]={0,0,0};
    arm=ARM_DISARMED;override=false;gyro_ok=true;zero_g=false;truth_level();
    memset(rc,0,sizeof rc);rc[3]=0.5f;loop_mixer_dshot();attitude_init();
    if(!control_mode_set(mode))return false;
    step(still);rc[4]=1;arm=ARM_ARMED;step(still);
    return attitude_ready() && arm==ARM_ARMED;
}
/* Full-stick flip on one axis at ~600 deg/s, asserting every cascade. */
static int flip(control_mode_t mode,unsigned axis,float dps,unsigned ms,float max_err,float *worst){
    float rate[3]={0,0,0};rate[axis]=dps;rc[axis]=dps>0?1.f:-1.f;
    for(unsigned i=0;i<ms;i++){
        step(rate);
        CHECK(arm==ARM_ARMED);CHECK(motors[0]>0);
        CHECK(attitude_ready());CHECK(attitude_state()==ATTITUDE_VALID);
        CHECK(control_level_fallback()==LEVEL_FALLBACK_NONE);
        CHECK(strcmp(control_effective_name(),mode==CONTROL_MODE_HORIZON?"horizon":"angle")==0);
        const float err=tilt_error();if(err>*worst)*worst=err;CHECK(err<max_err);
    }
    rc[axis]=0;return 0;
}
/* Centered sticks: leveled control is back in charge of the PID setpoint. */
static int leveled_resumes(control_mode_t mode){
    static const float bank[3]={50,0,0},still[3]={0,0,0};
    for(unsigned i=0;i<200;i++)step(bank); /* 10 deg true right bank */
    step(still);
    float desired[3];
    if(mode==CONTROL_MODE_HORIZON)horizon_setpoint(rc,desired);else attitude_setpoint(rc,desired);
    CHECK(desired[0]< -30.f); /* leveling demand from the estimate, not a rate demand */
    CHECK(fabsf(captured.roll-0.001f*desired[0])<1e-5f);
    CHECK(fabsf(attitude_degrees()[0]-10.f)<1.f);
    return 0;
}
int main(void){
    config_init();mode_range_init();
    CHECK(config_set_key("pid_roll_p",0.001f));CHECK(config_set_key("pid_pitch_p",0.001f));CHECK(config_set_key("pid_yaw_p",0.001f));
    CHECK(config_set_key("pid_roll_i",0));CHECK(config_set_key("pid_pitch_i",0));CHECK(config_set_key("pid_yaw_i",0));
    CHECK(config_set_key("pid_roll_d",0));CHECK(config_set_key("pid_pitch_d",0));
    static const float still[3]={0,0,0};
    float worst=0.f;const uint32_t engaged=control_level_fallback_count();

    /* 1. The reported failure: Horizon, full pitch stick, 600 deg/s. The old
     * Euler estimator gave up near 84 deg and the cascade disarmed. Pitch up
     * through 90 to 180 (inverted), then on through 360 back to level. */
    CHECK(prime(CONTROL_MODE_HORIZON));
    CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,150,2.f,&worst)==0);
    CHECK(fabsf(attitude_degrees()[1]-90.f)<2.f);  /* vertical, still valid */
    rc[1]=1;CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,150,2.f,&worst)==0);
    CHECK(fabsf(fabsf(attitude_degrees()[0])-180.f)<3.f && fabsf(attitude_degrees()[1])<3.f); /* inverted */
    rc[1]=1;CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,300,2.f,&worst)==0);
    CHECK(fabsf(attitude_degrees()[0])<2.f && fabsf(attitude_degrees()[1])<2.f);
    CHECK(leveled_resumes(CONTROL_MODE_HORIZON)==0);
    /* 2. Pitch through 90 (to 150) and back, nose-down direction too. */
    CHECK(prime(CONTROL_MODE_HORIZON));
    CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,250,2.f,&worst)==0);
    CHECK(flip(CONTROL_MODE_HORIZON,1,-600.f,250,2.f,&worst)==0);
    CHECK(flip(CONTROL_MODE_HORIZON,1,-600.f,250,2.f,&worst)==0);
    CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,250,2.f,&worst)==0);
    CHECK(fabsf(attitude_degrees()[1])<2.f);CHECK(leveled_resumes(CONTROL_MODE_HORIZON)==0);
    /* 3. Roll flip, full roll stick, 360 deg at 600 deg/s. */
    CHECK(prime(CONTROL_MODE_HORIZON));
    CHECK(flip(CONTROL_MODE_HORIZON,0,600.f,600,2.f,&worst)==0);
    CHECK(fabsf(attitude_degrees()[0])<2.f && fabsf(attitude_degrees()[1])<2.f);
    CHECK(leveled_resumes(CONTROL_MODE_HORIZON)==0);
    /* 4. Throttle-chop flip: zero g, gyro-only propagation stays valid. */
    CHECK(prime(CONTROL_MODE_HORIZON));zero_g=true;
    CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,600,1.f,&worst)==0);
    zero_g=false;CHECK(leveled_resumes(CONTROL_MODE_HORIZON)==0);
    /* 5. Angle mode tolerates a vertical/inverted excursion without fallback. */
    CHECK(prime(CONTROL_MODE_ANGLE));
    CHECK(flip(CONTROL_MODE_ANGLE,1,600.f,600,2.f,&worst)==0);
    CHECK(leveled_resumes(CONTROL_MODE_ANGLE)==0);
    CHECK(control_level_fallback_count()==engaged); /* no fallback was needed */
    fprintf(stderr,"worst tilt error during flips: %.3f deg\n",(double)worst);

    /* 6. Fallback engages only when needed: non-finite accelerometer data in
     * Angle mode. No disarm; rate control; leveling resumes after recovery. */
    CHECK(prime(CONTROL_MODE_ANGLE));
    accel[0]=NAN;now+=1000;memset(gyro,0,sizeof gyro);loop_gyro();loop_filter();loop_pid();loop_mixer_dshot();
    CHECK(arm==ARM_ARMED);CHECK(motors[0]>0);CHECK(!attitude_ready());
    CHECK(attitude_state()==ATTITUDE_ACCEL_INVALID);CHECK(strcmp(attitude_state_name(),"accel-invalid")==0);
    CHECK(control_level_fallback()==LEVEL_FALLBACK_ATTITUDE);CHECK(strcmp(control_level_fallback_name(),"attitude-invalid")==0);
    CHECK(strcmp(control_effective_name(),"acro")==0);CHECK(control_level_fallback_count()==engaged+1);
    rc[0]=0.5f;step(still);float desired[3];
    { float rate_sp[3];rates_update(rc,rate_sp);CHECK(fabsf(captured.roll-0.001f*rate_sp[0])<1e-5f); } /* pilot rate demand */
    rc[0]=0;
    unsigned recover_ms=0;
    while(control_level_fallback()!=LEVEL_FALLBACK_NONE && recover_ms<2000){
        step(still);recover_ms++;CHECK(arm==ARM_ARMED);
        if(control_level_fallback()!=LEVEL_FALLBACK_NONE)CHECK(attitude_state()==ATTITUDE_RECOVERING);
    }
    CHECK(recover_ms>=499 && recover_ms<=501);
    CHECK(attitude_ready());CHECK(strcmp(control_effective_name(),"angle")==0);
    CHECK(control_level_fallback_count()==engaged+1);
    step(still);attitude_setpoint(rc,desired);CHECK(fabsf(captured.roll-0.001f*desired[0])<1e-5f);

    /* 7. Gravity reference absent (zero g) for longer than the timeout:
     * fallback only after ATTITUDE_GRAVITY_TIMEOUT_S, then recovery. */
    CHECK(prime(CONTROL_MODE_HORIZON));zero_g=true;
    const unsigned timeout_ms=(unsigned)(ATTITUDE_GRAVITY_TIMEOUT_S*1000.f);
    for(unsigned i=0;i<timeout_ms-10;i++){step(still);CHECK(control_level_fallback()==LEVEL_FALLBACK_NONE);}
    for(unsigned i=0;i<20;i++)step(still);
    CHECK(arm==ARM_ARMED);CHECK(attitude_state()==ATTITUDE_GRAVITY_TIMEOUT);
    CHECK(control_level_fallback()==LEVEL_FALLBACK_ATTITUDE);CHECK(strcmp(control_effective_name(),"acro")==0);
    zero_g=false;for(unsigned i=0;i<510;i++){step(still);CHECK(arm==ARM_ARMED);}
    CHECK(attitude_ready());CHECK(control_level_fallback()==LEVEL_FALLBACK_NONE);
    CHECK(strcmp(control_effective_name(),"horizon")==0);CHECK(control_level_fallback_count()==engaged+2);

    /* 8. #103 unchanged: an invalid gyro mid-flip still disarms, never
     * advances the filter chain, and invalidates attitude. */
    for(unsigned fault=0;fault<3;fault++){
        CHECK(prime(CONTROL_MODE_HORIZON));
        CHECK(flip(CONTROL_MODE_HORIZON,1,600.f,140,2.f,&worst)==0); /* ~84 deg */
        float rate[3]={0,600.f,0};
        if(fault==0)gyro_ok=false;else rate[fault]=(fault==1)?NAN:INFINITY;
        unsigned filtered=filter_calls;
        memcpy(gyro,rate,sizeof gyro);now+=1000;loop_gyro();loop_filter();loop_pid();loop_mixer_dshot();
        CHECK(arm==ARM_DISARMED);CHECK(filter_calls==filtered);CHECK(!attitude_ready());
        CHECK(attitude_state()==ATTITUDE_UNINITIALIZED);
        for(unsigned i=0;i<4;i++)CHECK(motors[i]==0);
        gyro_ok=true;
    }
    puts("PASS N1: 600 deg/s Horizon pitch flips through 90/180/360 and roll flip without disarm or fallback, zero-g flip, Angle excursion, accel-invalid and gravity-timeout rate fallback with recovery, gyro-invalid disarm unchanged");
    return 0;
}
