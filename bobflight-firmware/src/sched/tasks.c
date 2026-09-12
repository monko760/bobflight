/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cascade + background task bodies.
 */
#include "sched/tasks.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/rx.h"
#include "drivers/cli.h"
#include "flight/pid.h"
#include "flight/mixer.h"
#include "flight/rates.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "hal/hal.h"
#include "flight/attitude.h"
#include <math.h>
static uint64_t last_sample;
static float sample_dt=0.001f;
static bool sample_ok,arm_low_seen;
static unsigned bench_motor;
static uint32_t bench_started;
bool bench_motor_test(unsigned motor){
    if(motor==0){bench_motor=0;return true;}
    if(motor>4 || arming_state()==ARM_ARMED || !hal_usb_cdc_connected() || !dshot_is_healthy())return false;
    bench_motor=motor;bench_started=hal_millis();return true;
}

static float g_gyro_raw[3];
static float g_gyro_filt[3];
static float g_setpoint[3];
static float g_motors[MIXER_MOTOR_COUNT];
static pid_axis_out_t g_pid;

void loop_gyro(void)
{
    uint64_t now=hal_micros();
    sample_dt=last_sample?(float)(now-last_sample)*0.000001f:0.001f; last_sample=now;
    sample_ok=gyro_sample(g_gyro_raw);
    if(!sample_ok || sample_dt>0.01f){arming_disarm();arm_low_seen=false;}
    if(sample_ok)sample_ok=attitude_update(g_gyro_raw,gyro_accel_g(),sample_dt);
}

void loop_filter(void)
{
    gyro_filter(g_gyro_raw, g_gyro_filt);
}

void loop_pid(void)
{
    const float *rc = rx_channels();
    float sticks[4] = {0.f, 0.f, 0.f, 0.f};
    if (rc) {
        sticks[0] = rc[0];
        sticks[1] = rc[1];
        sticks[2] = rc[2];
        sticks[3] = rc[3];
    }
    if(!rx_frame_fresh() || failsafe_active() || !sample_ok || !dshot_is_healthy()) {arming_disarm();arm_low_seen=false;}
    else if(rc[4]<0.f) {arming_disarm();arm_low_seen=true;}
    else if(rc[4]>0.5f && arm_low_seen && arming_state()!=ARM_ARMED) {
        arm_low_seen=false; /* Every arm attempt requires a new low-to-high switch edge. */
        const float *angles=attitude_degrees();
        if(gyro_calibrated() && attitude_ready() && fabsf(angles[0])<20.f && fabsf(angles[1])<20.f && arming_try_arm())arm_low_seen=false;
    }
    attitude_setpoint(sticks,g_setpoint);
    pid_set_dt(sample_dt);
    if(arming_state()!=ARM_ARMED || sticks[3]<0.05f){pid_init();g_pid=(pid_axis_out_t){0};}
    else pid_update(g_gyro_filt,g_setpoint,&g_pid);
}

void loop_mixer_dshot(void)
{
    float throttle = 0.f;
    const float *rc = rx_channels();
    if (rc) {
        throttle = rc[3];
    }

    if (arming_state() != ARM_ARMED || failsafe_active()) {
        for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
            g_motors[i] = 0.f;
        }
    } else {
        mixer_update(&g_pid, throttle, g_motors);
    }
    if(bench_motor && arming_state()!=ARM_ARMED && hal_usb_cdc_connected() && (uint32_t)(hal_millis()-bench_started)<1000u)g_motors[bench_motor-1]=0.08f;
    else bench_motor=0;
    dshot_write(g_motors);
}

void bg_rx_poll(void)
{
    rx_poll();
}

void bg_cli_poll(void)
{
    cli_poll();
}

void bg_failsafe_tick(void)
{
    failsafe_tick(hal_millis());
}
