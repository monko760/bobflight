/* SPDX-License-Identifier: Apache-2.0
 * Actual task routing + rates + PID + attitude with mock RX/clock/arming/motors.
 * Mock arming is test-only. No physical motor or flight qualification.
 * Axis indexes are zero-based: roll=0, pitch=1, yaw=2.
 */
#include "sched/tasks.h"
#include "flight/arming.h"
#include "flight/attitude.h"
#include "flight/config.h"
#include "flight/mode_range.h"
#include "flight/horizon.h"
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
static bool healthy=true, calibrating, override, fresh=true,usb=true,gyro_ok=true;
static float rc[16], gyro[3], accel[3]={0,0.5f,0.8660254f};
static float motors[4];
static pid_axis_out_t captured;
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000u);}
bool hal_usb_cdc_connected(void){return usb;}
arm_state_t arming_state(void){return arm;}
void arming_disarm(void){arm=ARM_DISARMED;}
bool arming_try_arm(void){return false;}
void gyro_calibration_tick(void){}
bool gyro_manual_calibration_active(void){return calibrating;}
bool gyro_sample(float out[3]){memcpy(out,gyro,sizeof(gyro));return gyro_ok;}
void gyro_filter(const float in[3],float out[3]){memcpy(out,in,sizeof(gyro));}
const float *gyro_accel_g(void){return accel;}
bool gyro_calibrated(void){return gyro_ok;}
const float *rx_channels(void){return rc;}
bool rx_frame_fresh(void){return fresh;}
void rx_poll(void){}
void cli_poll(void){}
void failsafe_tick(uint32_t t){(void)t;}
bool failsafe_command_override(float s[4]){
    if(!override)return false;
    s[0]=s[1]=s[2]=0.f;
    return true;
}
bool dshot_is_healthy(void){return healthy;}
void dshot_write(const float m[4]){memcpy(motors,m,sizeof(motors));}
void mixer_update(const pid_axis_out_t *p,float t,float out[4]){
    captured=*p;for(unsigned i=0;i<4;i++)out[i]=t;
}
#define CHECK(c) do{if(!(c)){fprintf(stderr,"control mode FAIL %d: %s\n",__LINE__,#c);return 1;}}while(0)
#define NEAR(a,b) (fabsf((a)-(b))<0.000002f)
#if !defined(BOBFLIGHT_FLIGHT_ENABLE) || !BOBFLIGHT_FLIGHT_ENABLE
static void tick(uint64_t dt){now+=dt;loop_gyro();loop_filter();loop_pid();loop_mixer_dshot();}
static bool prime(control_mode_t mode){
    arm=ARM_DISARMED;override=false;healthy=true;calibrating=false;
    bench_motor_test(0);loop_mixer_dshot();
    attitude_init();rc[4]=0;rc[3]=0.4f;
    if(!control_source_set(false) || !control_mode_set(mode))return false;
    tick(1000);arm=ARM_ARMED;tick(1000); /* actual task primes; mock arm only */
    return true;
}
static bool configure(void){
    config_init();
    return config_set_key("rate_expo",0) &&
        config_set_key("rate_max_roll",100) && config_set_key("rate_max_pitch",100) && config_set_key("rate_max_yaw",100) &&
        config_set_key("pid_roll_p",0.001f) && config_set_key("pid_pitch_p",0.001f) && config_set_key("pid_yaw_p",0.001f) &&
        config_set_key("pid_roll_i",0) && config_set_key("pid_pitch_i",0) && config_set_key("pid_yaw_i",0) &&
        config_set_key("pid_roll_d",0) && config_set_key("pid_pitch_d",0);
}
#endif
int main(void){
    mode_range_init();
    CHECK(control_mode_get()==CONTROL_MODE_ANGLE);
    CHECK(strcmp(control_mode_name(),"angle")==0);
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    CHECK(!bench_switch_start());
    CHECK(!control_mode_set(CONTROL_MODE_HORIZON));
    CHECK(!control_source_set(true));
    CHECK(control_source_set(false));
    CHECK(control_mode_requested()==CONTROL_MODE_ANGLE);
    CHECK(!control_mode_set(CONTROL_MODE_ACRO));
    CHECK(control_mode_get()==CONTROL_MODE_ANGLE);
    CHECK(control_mode_set(CONTROL_MODE_ANGLE));
    CHECK(arm==ARM_DISARMED);
    puts("PASS: experimental Acro refused in flight-enabled build");return 0;
#else
    /* Real mixer/DShot endpoint: no gyro required, flight stays disarmed. */
    gyro_ok=false;rc[3]=0;rc[4]=1;CHECK(!bench_switch_start());
    rc[4]=-1;CHECK(bench_switch_start());CHECK(bench_motor_active());
    CHECK(!bench_motor_pulse(1,8));CHECK(!bench_motor_seq_start());
    CHECK(!mode_range_set(MODE_ARM,true,2,1751,2100));
    tick(1000);for(unsigned i=0;i<4;i++)CHECK(motors[i]==0);
    rc[4]=0;tick(1000);CHECK(motors[0]==0);
    CHECK(strcmp(bench_switch_status(),"waiting-for-high")==0);
    rc[4]=1;tick(1000);CHECK(arm==ARM_DISARMED);
    for(unsigned i=0;i<4;i++)CHECK(NEAR(motors[i],0.08f));
    CHECK(strcmp(bench_switch_status(),"running-8-percent")==0);
    for(unsigned i=0;i<3001;i++)tick(1000);
    for(unsigned i=0;i<4;i++)CHECK(motors[i]==0);
    tick(1000);CHECK(motors[0]==0); /* held-high cannot restart */
    rc[4]=-1;tick(1000);rc[4]=1;tick(1000);CHECK(motors[0]>0);
    rc[4]=-1;tick(1000);CHECK(motors[0]==0);bench_switch_stop();tick(1000);
    for(unsigned failure=0;failure<7;failure++){
      fresh=true;healthy=true;usb=true;calibrating=false;rc[3]=0;rc[4]=-1;
      CHECK(bench_switch_start());tick(1000);rc[4]=1;tick(1000);CHECK(motors[0]>0);
      if(failure==0)fresh=false;
      if(failure==1)usb=false;
      if(failure==2)healthy=false;
      if(failure==3)calibrating=true;
      if(failure==4)rc[3]=0.2f;
      if(failure==5)rc[4]=NAN;
      tick(failure==6?21000:1000);
      for(unsigned i=0;i<4;i++)CHECK(motors[i]==0);
      CHECK(!bench_motor_active());
      const char *reasons[]={"receiver-stale","usb-disconnected","dshot-unhealthy","manual-calibration","throttle-not-low","aux1-invalid","mixer-gap-over-20ms"};
      CHECK(strcmp(bench_switch_status(),reasons[failure])==0);
    }
    fresh=true;healthy=true;usb=true;calibrating=false;rc[3]=0;rc[4]=-1;
    CHECK(bench_switch_start());tick(1000);rc[4]=1;tick(1000);
    CHECK(bench_motor_test(0));CHECK(bench_motor_active());tick(1000);CHECK(!bench_motor_active());
    rc[4]=-1;CHECK(bench_switch_start());
    for(unsigned i=0;i<60001;i++)tick(1000);
    CHECK(!bench_motor_active());
    gyro_ok=true;
    CHECK(configure());
    CHECK(!control_mode_set((control_mode_t)99));
    CHECK(!control_mode_set((control_mode_t)-1));
    CHECK(control_mode_get()==CONTROL_MODE_ANGLE);
    CHECK(control_mode_set(CONTROL_MODE_ACRO));CHECK(arm==ARM_DISARMED);
    arm=ARM_ARMED;CHECK(!control_mode_set(CONTROL_MODE_ANGLE));CHECK(!control_source_set(true));arm=ARM_DISARMED;
    calibrating=true;CHECK(!control_mode_set(CONTROL_MODE_ANGLE));
    CHECK(!control_source_set(true));CHECK(!mode_range_set(MODE_HORIZON,true,2,1301,1700));calibrating=false;
    CHECK(bench_motor_pulse(1,10));CHECK(!control_mode_set(CONTROL_MODE_ANGLE));
    loop_mixer_dshot();CHECK(bench_motor_test(0));
    CHECK(bench_motor_active());CHECK(!control_mode_set(CONTROL_MODE_ANGLE));CHECK(!control_source_set(true));
    loop_mixer_dshot();CHECK(control_mode_set(CONTROL_MODE_ANGLE));

    /* Acro ignores tilt in setpoints; exact expo=0 shaped rates: 100,-50,50 dps. */
    rc[0]=1;rc[1]=-0.51f;rc[2]=0.51f;gyro[0]=10;gyro[1]=-20;gyro[2]=5;
    CHECK(prime(CONTROL_MODE_ACRO));CHECK(NEAR(captured.roll,0));tick(1000);
    CHECK(arm==ARM_ARMED);
    CHECK(NEAR(captured.roll,0.09f));CHECK(NEAR(captured.pitch,-0.03f));CHECK(NEAR(captured.yaw,0.045f));
    /* Actual Angle outer-loop routing remains the default path. */
    CHECK(prime(CONTROL_MODE_ANGLE));tick(1000);
    float desired[3];attitude_setpoint(rc,desired);
    CHECK(NEAR(captured.roll,0.001f*(desired[0]-gyro[0])));
    CHECK(NEAR(captured.pitch,0.001f*(desired[1]-gyro[1])));
    CHECK(NEAR(captured.yaw,0.001f*(desired[2]-gyro[2])));
    /* Failsafe leveling override takes precedence over selected Acro. */
    CHECK(prime(CONTROL_MODE_ACRO));override=true;tick(1000);
    float neutral[4]={0,0,0,0.4f};attitude_setpoint(neutral,desired);
    CHECK(control_mode_get()==CONTROL_MODE_ACRO);
    CHECK(NEAR(captured.roll,0.001f*(desired[0]-gyro[0])));
    CHECK(NEAR(captured.pitch,0.001f*(desired[1]-gyro[1])));
    CHECK(NEAR(captured.yaw,-0.001f*gyro[2]));
    override=false;tick(1000);CHECK(NEAR(captured.roll,0.09f));

    /* Horizon routing uses production blending and preserves rate-feedback units. */
    rc[0]=0.55f;rc[1]=-0.2f;rc[2]=0.51f;
    CHECK(prime(CONTROL_MODE_HORIZON));tick(1000);horizon_setpoint(rc,desired);
    CHECK(NEAR(captured.roll,0.001f*(desired[0]-gyro[0])));
    CHECK(NEAR(captured.pitch,0.001f*(desired[1]-gyro[1])));
    CHECK(NEAR(captured.yaw,0.001f*(desired[2]-gyro[2])));
    CHECK(strcmp(control_effective_name(),"horizon")==0);
    override=true;tick(1000);attitude_setpoint(neutral,desired);
    CHECK(strcmp(control_effective_name(),"angle")==0);
    CHECK(NEAR(captured.roll,0.001f*(desired[0]-gyro[0])));override=false;

    /* AUX switch routing is explicit opt-in, ARM range is not an arm assignment. */
    arm=ARM_DISARMED;loop_mixer_dshot();
    CHECK(mode_range_set(MODE_ANGLE,true,2,900,1300));
    CHECK(mode_range_set(MODE_HORIZON,true,2,1301,1700));
    CHECK(mode_range_set(MODE_ACRO,true,2,1701,2100));
    CHECK(control_source_set(true));CHECK(arm==ARM_DISARMED);
    rc[5]=1;CHECK(control_mode_requested()==CONTROL_MODE_ACRO);CHECK(!control_mode_conflict());
    tick(1000);arm=ARM_ARMED;tick(1000);tick(1000);
    CHECK(strcmp(control_effective_name(),"acro")==0);
    rc[5]=0;tick(1000);CHECK(strcmp(control_effective_name(),"horizon")==0);
    rc[5]=-1;tick(1000);CHECK(strcmp(control_effective_name(),"angle")==0);
    rc[5]=1;fresh=false;tick(1000);CHECK(strcmp(control_effective_name(),"angle")==0);fresh=true;
    rc[5]=NAN;tick(1000);CHECK(strcmp(control_effective_name(),"angle")==0);
    rc[5]=2;tick(1000);CHECK(strcmp(control_effective_name(),"angle")==0);
    rc[5]=1;override=true;tick(1000);
    CHECK(control_mode_requested()==CONTROL_MODE_ACRO);CHECK(strcmp(control_effective_name(),"angle")==0);override=false;
    arm=ARM_DISARMED;loop_mixer_dshot();
    CHECK(mode_range_set(MODE_ANGLE,true,2,900,2100));
    CHECK(control_mode_conflict());CHECK(control_mode_requested()==CONTROL_MODE_ANGLE);
    CHECK(mode_range_set(MODE_ANGLE,false,2,900,2100));
    CHECK(mode_range_set(MODE_ACRO,false,2,1701,2100));
    CHECK(!control_mode_conflict());CHECK(control_mode_requested()==CONTROL_MODE_ANGLE);
    CHECK(mode_range_set(MODE_ARM,true,2,900,2100));
    CHECK(mode_range_is_active(MODE_ARM));tick(1000);CHECK(arm==ARM_DISARMED);
    mode_range_reset();CHECK(!mode_range_get(MODE_ACRO)->enabled);CHECK(!mode_range_get(MODE_HORIZON)->enabled);
    CHECK(control_source_set(false));

    /* Real PID I integration follows measured invocation time at dividers 1/2/4/8. */
    memset(gyro,0,sizeof(gyro));rc[0]=1;rc[1]=rc[2]=0;
    CHECK(config_set_key("pid_roll_p",0));CHECK(config_set_key("pid_roll_i",0.005f));
    for(unsigned div=1;div<=8;div*=2){
        CHECK(prime(CONTROL_MODE_ACRO));
        for(unsigned i=0;i<div;i++){now+=1000;loop_gyro();loop_filter();}
        loop_pid();loop_mixer_dshot();
        CHECK(NEAR(captured.roll,0.0005f*(float)div));
    }
    /* Existing low-throttle reset and restart priming stay effective. */
    CHECK(prime(CONTROL_MODE_ACRO));tick(1000);CHECK(NEAR(captured.roll,0.0005f));
    rc[3]=0;tick(1000);CHECK(NEAR(captured.roll,0));
    rc[3]=0.4f;tick(1000);CHECK(NEAR(captured.roll,0));
    tick(1000);CHECK(NEAR(captured.roll,0.0005f));
    /* Existing health and invalid-time disarming stays in place, even in Acro. */
    healthy=false;tick(1000);CHECK(arm==ARM_DISARMED);
    for(unsigned i=0;i<4;i++)CHECK(motors[i]==0);
    CHECK(prime(CONTROL_MODE_ACRO));loop_pid();CHECK(arm==ARM_DISARMED);
    CHECK(prime(CONTROL_MODE_ACRO));attitude_init();accel[0]=-1;accel[1]=accel[2]=0;
    tick(1000);CHECK(arm==ARM_DISARMED); /* estimator pitch singularity is NOT bypassed */
    puts("PASS: real Acro/Angle routing, feedback units/sign, failsafe precedence, guards, measured dt dividers1/2/4/8, reset/prime and existing health gate");return 0;
#endif
}
