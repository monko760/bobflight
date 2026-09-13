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
/* PID uses its own invocation clock, never the latest gyro sample interval. */
static uint64_t last_pid_us;
static bool have_pid_time;
static bool sample_ok,arm_low_seen;
static unsigned bench_motor;
/* Remain busy until a cascade has actually submitted the stop frame. */
static bool bench_output_pending;
bool bench_motor_active(void){return bench_motor != 0u || bench_output_pending;}
static control_mode_t g_control_mode = CONTROL_MODE_ANGLE;
control_mode_t control_mode_get(void) { return g_control_mode; }
const char *control_mode_name(void) {
    return g_control_mode == CONTROL_MODE_ACRO ? "acro" : "angle";
}
bool control_mode_set(control_mode_t mode) {
    if (mode != CONTROL_MODE_ANGLE && mode != CONTROL_MODE_ACRO) return false;
    if (arming_state() == ARM_ARMED || bench_motor_active() ||
        gyro_manual_calibration_active()) return false;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    /* Acro routing has not been flight-qualified: bench builds only. */
    if (mode == CONTROL_MODE_ACRO) return false;
#endif
    g_control_mode = mode;
    return true;
}
static uint32_t bench_started;
static unsigned bench_seq_step; /* 0 = single test; 1..4 = running sequence */
static float bench_throttle = 0.08f;
bool bench_motor_pulse(unsigned motor, unsigned percent){
    if(motor<1u || motor>4u || percent>BENCH_PULSE_MAX_PERCENT)return false;
    if(percent==0u){bench_motor=0;bench_seq_step=0;return true;}
    if(arming_state()==ARM_ARMED || !hal_usb_cdc_connected() || !dshot_is_healthy() || gyro_manual_calibration_active())return false;
    bench_seq_step=0;bench_motor=motor;bench_throttle=(float)percent/100.f;
    bench_started=hal_millis();return true;
}
bool bench_motor_test(unsigned motor){
    if(motor==0u){bench_motor=0;bench_seq_step=0;return true;}
    return bench_motor_pulse(motor,8u);
}

bool bench_motor_seq_start(void){
    if(arming_state()==ARM_ARMED || !hal_usb_cdc_connected() || !dshot_is_healthy() || gyro_manual_calibration_active())return false;
    bench_seq_step=1;bench_motor=1;bench_throttle=0.08f;bench_started=hal_millis();return true;
}

static float g_gyro_raw[3];
static float g_gyro_filt[3];
static float g_setpoint[3];
static float g_motors[MIXER_MOTOR_COUNT];
static pid_axis_out_t g_pid;

void loop_gyro(void)
{
    gyro_calibration_tick();
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
    const uint64_t pid_now=hal_micros();
    const bool pid_first=!have_pid_time;
    const uint64_t pid_elapsed=pid_first?0:pid_now-last_pid_us;
    /* Match pid_set_dt's strict <20ms domain; never reuse stale dt on error. */
    const bool pid_time_ok=pid_first || (pid_now>last_pid_us && pid_elapsed<20000u);
    last_pid_us=pid_now;have_pid_time=true;
    const float *rc = rx_channels();
    float sticks[4] = {0.f, 0.f, 0.f, 0.f};
    if (rc) {
        sticks[0] = rc[0];
        sticks[1] = rc[1];
        sticks[2] = rc[2];
        sticks[3] = rc[3];
    }
    /* Failsafe owns RX-loss disarm timing (staged); cascade keeps flying
     * level commands from failsafe_command_override() while the window runs. */
    const bool fs_flying = failsafe_command_override(sticks);
    if(!sample_ok || !dshot_is_healthy() || !pid_time_ok) {arming_disarm();arm_low_seen=false;}
    else if(fs_flying) {arm_low_seen=false;}
    else if(rc[4]<0.f) {arming_disarm();arm_low_seen=true;}
    else if(rc[4]>0.5f && arm_low_seen && arming_state()!=ARM_ARMED) {
        arm_low_seen=false; /* Every arm attempt requires a new low-to-high switch edge. */
        const float *angles=attitude_degrees();
        if(gyro_calibrated() && attitude_ready() && fabsf(angles[0])<20.f && fabsf(angles[1])<20.f && arming_try_arm())arm_low_seen=false;
    }
    /* Preserve the existing leveling override during staged failsafe. */
    if (g_control_mode == CONTROL_MODE_ACRO && !fs_flying)
        rates_update(sticks,g_setpoint);
    else
        attitude_setpoint(sticks,g_setpoint);
    if(arming_state()!=ARM_ARMED || sticks[3]<0.05f){
        pid_init();g_pid=(pid_axis_out_t){0};have_pid_time=false;
    } else if(pid_first){
        /* Prime after startup/disarm/low throttle; no invented first interval. */
        pid_init();g_pid=(pid_axis_out_t){0};
    } else {
        pid_set_dt((float)pid_elapsed*0.000001f);
        pid_update(g_gyro_filt,g_setpoint,&g_pid);
    }
}

void loop_mixer_dshot(void)
{
    float throttle = 0.f;
    const float *rc = rx_channels();
    if (rc) {
        throttle = rc[3];
    }

    /* Failsafe's own disarm (DROP / land timer) is what stops motors;
     * PROCEDURE(LAND) must reach the mixer with its descent throttle. */
    if (arming_state() != ARM_ARMED) {
        for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
            g_motors[i] = 0.f;
        }
    } else {
        mixer_update(&g_pid, throttle, g_motors);
    }
    if(bench_motor) {
        if(arming_state()==ARM_ARMED || !hal_usb_cdc_connected() || !dshot_is_healthy() || gyro_manual_calibration_active()) {bench_motor=0;bench_seq_step=0;}
        else {
            const uint32_t bench_dt=(uint32_t)(hal_millis()-bench_started);
            if(bench_dt<1000u) g_motors[bench_motor-1]=bench_throttle;
            else if(bench_seq_step==0u) bench_motor=0;      /* single test done */
            else if(bench_dt<1700u) { /* 0.7s all-off gap between motors */ }
            else if(bench_seq_step<4u) {bench_seq_step++;bench_motor=bench_seq_step;bench_started=hal_millis();}
            else {bench_motor=0;bench_seq_step=0;}
        }
    }
    dshot_write(g_motors);
    bench_output_pending=false;
    for(unsigned i=0;i<MIXER_MOTOR_COUNT;i++)
        if(g_motors[i]>0.f)bench_output_pending=true;
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
