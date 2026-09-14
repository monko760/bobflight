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
#include "flight/pid_diag.h"
#include "flight/mixer.h"
#include "flight/rates.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "hal/hal.h"
#include "flight/attitude.h"
#include "flight/horizon.h"
#include "flight/mode_range.h"
#include <math.h>
#include <stddef.h>
static uint64_t last_sample;
static float sample_dt=0.001f;
/* PID uses its own invocation clock, never the latest gyro sample interval. */
static uint64_t last_pid_us;
static bool have_pid_time;
static bool sample_ok,arm_low_seen;
static uint32_t arm_revision_seen;
static unsigned bench_motor;
/* Remain busy until a cascade has actually submitted the stop frame. */
static bool bench_output_pending;
static bool switch_enabled,switch_low,switch_running;
static uint32_t switch_session_ms,switch_run_ms,switch_tick_ms;
static const char *switch_status="disabled";
const char *bench_switch_status(void){return switch_status;}
bool bench_motor_active(void){return bench_motor != 0u || bench_output_pending || switch_enabled;}
void bench_switch_stop(void){switch_enabled=false;switch_low=false;switch_running=false;switch_status="explicit-stop";}
static const char *switch_blocker(const float *rc){
    if(arming_state()==ARM_ARMED)return "flight-armed";
    if(!hal_usb_cdc_connected())return "usb-disconnected";
    if(!dshot_is_healthy())return "dshot-unhealthy";
    if(gyro_manual_calibration_active())return "manual-calibration";
    if(!rx_frame_fresh())return "receiver-stale";
    if(!rc)return "receiver-missing";
    if(!isfinite(rc[3])||rc[3]<0.f||rc[3]>0.05f)return "throttle-not-low";
    if(!isfinite(rc[4])||rc[4]<-1.f||rc[4]>1.f)return "aux1-invalid";
    return NULL;
}
bool bench_switch_start(void){
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    switch_status="flight-build-refused";
    return false;
#else
    const float *rc=rx_channels();
    if(bench_motor_active())return false; /* Do not overwrite an active session's state. */
    const char *reason=switch_blocker(rc);
    if(reason){switch_status=reason;return false;}
    if(rc[4]>=0.f){switch_status="aux1-not-low";return false;}
    switch_enabled=true;switch_low=false;switch_running=false;
    switch_status="waiting-for-low";
    switch_session_ms=switch_tick_ms=hal_millis();return true;
#endif
}
static float bench_switch_output(void){
    if(!switch_enabled)return 0.f;
    uint32_t now=hal_millis();const float *rc=rx_channels();
    const char *reason=switch_blocker(rc);
    if(!reason&&(uint32_t)(now-switch_session_ms)>=60000u)reason="session-expired";
    if(!reason&&(uint32_t)(now-switch_tick_ms)>20u)reason="mixer-gap-over-20ms";
    switch_tick_ms=now;
    if(reason){bench_switch_stop();switch_status=reason;return 0.f;}
    if(rc[4]<0.f){switch_low=true;switch_running=false;switch_status="waiting-for-high";return 0.f;}
    /* Preserve a witnessed low through a middle position or radio ramp.
     * Once consumed by a high edge it stays consumed until another low. */
    if(rc[4]<=0.5f){switch_running=false;switch_status=switch_low?"waiting-for-high":"waiting-for-low";return 0.f;}
    if(switch_low){switch_low=false;switch_running=true;switch_run_ms=now;switch_status="running-8-percent";}
    if(switch_running && (uint32_t)(now-switch_run_ms)>=3000u){switch_running=false;switch_status="run-limit-return-switch-low";}
    return switch_running?0.08f:0.f;
}
static control_mode_t g_control_mode = CONTROL_MODE_ANGLE;
static control_mode_t g_effective_mode = CONTROL_MODE_ANGLE;
static bool g_control_aux;
static const char *mode_name(control_mode_t mode) {
    return mode == CONTROL_MODE_ACRO ? "acro" : mode == CONTROL_MODE_HORIZON ? "horizon" : "angle";
}
control_mode_t control_mode_get(void) { return g_control_mode; }
const char *control_mode_name(void) { return mode_name(g_control_mode); }
const char *control_source_name(void) { return g_control_aux ? "aux" : "manual"; }
const char *control_effective_name(void) { return mode_name(g_effective_mode); }
static bool control_edit_allowed(void) {
    return arming_state() != ARM_ARMED && !bench_motor_active() &&
        !gyro_manual_calibration_active();
}
bool control_mode_set(control_mode_t mode) {
    if (mode != CONTROL_MODE_ANGLE && mode != CONTROL_MODE_ACRO && mode != CONTROL_MODE_HORIZON) return false;
    if (!control_edit_allowed()) return false;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    if (mode != CONTROL_MODE_ANGLE) return false;
#endif
    g_control_mode = mode;
    return true;
}
bool control_source_set(bool use_aux) {
    if (!control_edit_allowed()) return false;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    if (use_aux) return false;
#endif
    g_control_aux = use_aux;
    return true;
}
static control_mode_t resolve_control_mode(bool *conflict) {
    if(conflict)*conflict=false;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    return CONTROL_MODE_ANGLE; /* Development routing cannot escape bench builds. */
#else
    if(!g_control_aux)return g_control_mode;
    const bool angle=mode_range_is_active(MODE_ANGLE);
    const bool acro=mode_range_is_active(MODE_ACRO);
    const bool horizon=mode_range_is_active(MODE_HORIZON);
    const unsigned matches=(unsigned)angle+(unsigned)acro+(unsigned)horizon;
    if(conflict)*conflict=matches>1u;
    if(matches!=1u)return CONTROL_MODE_ANGLE; /* no match, stale RX, or overlap */
    return acro ? CONTROL_MODE_ACRO : horizon ? CONTROL_MODE_HORIZON : CONTROL_MODE_ANGLE;
#endif
}
control_mode_t control_mode_requested(void) { return resolve_control_mode(NULL); }
const char *control_requested_name(void) { return mode_name(control_mode_requested()); }
bool control_mode_conflict(void) { bool conflict;resolve_control_mode(&conflict);return conflict; }
static uint32_t bench_started;
static unsigned bench_seq_step; /* 0 = single test; 1..4 = running sequence */
static float bench_throttle = 0.08f;
bool bench_motor_pulse(unsigned motor, unsigned percent){
    if(motor<1u || motor>4u || percent>BENCH_PULSE_MAX_PERCENT)return false;
    if(percent==0u){bench_motor=0;bench_seq_step=0;bench_switch_stop();return true;}
    if(switch_enabled)return false;
    if(arming_state()==ARM_ARMED || !hal_usb_cdc_connected() || !dshot_is_healthy() || gyro_manual_calibration_active())return false;
    bench_seq_step=0;bench_motor=motor;bench_throttle=(float)percent/100.f;
    bench_started=hal_millis();return true;
}
bool bench_motor_test(unsigned motor){
    if(motor==0u){bench_motor=0;bench_seq_step=0;bench_switch_stop();return true;}
    return bench_motor_pulse(motor,8u);
}

bool bench_motor_seq_start(void){
    if(switch_enabled)return false;
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
    /* Independent bench state only; never feeds g_pid, mixer, or arming. */
    pid_diag_update(pid_now, g_gyro_filt);
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
    bool arm_requested = false;
    const bool arm_input_valid = mode_range_arm_input(&arm_requested);
    const uint32_t arm_revision = mode_range_arm_revision();
    if (arm_revision != arm_revision_seen) {
        arm_low_seen = false;
        arm_revision_seen = arm_revision;
        /* Normal configuration setters refuse edits while armed. */
        if (arming_state() == ARM_ARMED) arming_disarm();
    }
    if(!sample_ok || !dshot_is_healthy() || !pid_time_ok) {arming_disarm();arm_low_seen=false;}
    else if(fs_flying) {arm_low_seen=false;}
    /* HOLD/LAND above owns stale-link output. Otherwise an invalid input must
     * not create the inactive witness needed for a later arm request. */
    else if(!arm_input_valid || gyro_manual_calibration_active() ||
            (arming_state()!=ARM_ARMED && bench_motor_active())) {
        arming_disarm();arm_low_seen=false;
    }
    else if(!arm_requested) {arming_disarm();arm_low_seen=true;}
    else if(arm_low_seen && arming_state()!=ARM_ARMED) {
        arm_low_seen=false; /* Every attempt requires a fresh valid inactive-to-active range edge. */
        const float *angles=attitude_degrees();
        if(gyro_calibrated() && attitude_ready() && fabsf(angles[0])<20.f && fabsf(angles[1])<20.f && arming_try_arm())arm_low_seen=false;
    }
    /* Preserve the existing leveling override during staged failsafe. */
    g_effective_mode = fs_flying ? CONTROL_MODE_ANGLE : control_mode_requested();
    if (g_effective_mode == CONTROL_MODE_ACRO)
        rates_update(sticks,g_setpoint);
    else if (g_effective_mode == CONTROL_MODE_HORIZON)
        horizon_setpoint(sticks,g_setpoint);
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

    /* Use the same failsafe throttle override as the PID task.
     * Receiver memory intentionally retains the last real pilot frame. */
    float failsafe_sticks[4] = {0.f, 0.f, 0.f, 0.f};
    if (failsafe_command_override(failsafe_sticks))
        throttle = failsafe_sticks[3];

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
    const bool switch_was_enabled=switch_enabled;
    const float switch_output=bench_switch_output();
    if(switch_was_enabled)for(unsigned i=0;i<MIXER_MOTOR_COUNT;i++)g_motors[i]=switch_output;
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
