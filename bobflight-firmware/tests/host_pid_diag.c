/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Deterministic time, fresh-sample and safety inputs. Axes 0/1/2=roll/pitch/yaw.
 */
#include "flight/pid_diag.h"
#include "flight/pid.h"
#include "flight/config.h"
#include "flight/rates.h"
#include "flight/arming.h"
#include "drivers/gyro.h"
#include <stdio.h>
#include <math.h>
#include <float.h>
#include <string.h>
#include <assert.h>

static uint64_t now = 100000;
static bool usb = true, healthy = true, calibrated = true, manual = false, motor = false, rx_fresh = true;
static arm_state_t arm = ARM_DISARMED;
static float rc[16];
static unsigned writes;
static gyro_diagnostics_t gd = {.config_ok = true, .sample_seq = 1, .sample_ms = 100};

uint64_t hal_micros(void) { return now; }
uint32_t hal_millis(void) { return (uint32_t)(now / 1000); }
bool hal_usb_cdc_connected(void) { return usb; }
bool gyro_is_healthy(void) { return healthy; }
bool gyro_calibrated(void) { return calibrated; }
bool gyro_manual_calibration_active(void) { return manual; }
const gyro_diagnostics_t *gyro_diagnostics(void) { return &gd; }
bool bench_motor_active(void) { return motor; }
arm_state_t arming_state(void) { return arm; }
bool rx_frame_fresh(void) { return rx_fresh; }
const float *rx_channels(void) { return rc; }
void dshot_write(const float *v) { (void)v; writes++; }

static void fresh(unsigned us) { now += us; gd.sample_ms = hal_millis(); gd.sample_seq++; }
static pid_diag_snapshot_t snap(void) { pid_diag_snapshot_t s; pid_diag_get_snapshot(&s); return s; }
static void tick(unsigned us, const float *g) { fresh(us); pid_diag_update(now, g); }
static void near(float a, float b) { assert(fabsf(a - b) < 1e-6f); }

int main(void) {
    config_init();
    pid_diag_init();
    char text[1024];

    float zero[3] = {0}, g[3] = {10, -20, 30};
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    assert(!snap().valid);
    tick(1000, g);
    pid_diag_snapshot_t s = snap();
    assert(s.valid && s.dt_us == 1000 && s.sample_seq == 1);
    near(s.correction[0], -.02001f);
    near(s.error_dps[1], 20);
    assert(writes == 0);

    // Production PID reference and shadow must agree; interleaving must not mutate either state.
    pid_axis_out_t expected[5], actual;
    float frames[5][3] = {{1, 2, 3}, {2, -3, 4}, {-5, 0, 10}, {0, 0, 0}, {4, 5, 6}};
    pid_init();
    for (unsigned i = 0; i < 5; i++) {
        pid_set_dt(.001f);
        pid_update(frames[i], zero, &expected[i]);
    }
    pid_init();
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, zero);
    for (unsigned i = 0; i < 5; i++) {
        tick(1000, frames[i]);
        s = snap();
        assert(s.valid);
        near(s.correction[0], expected[i].roll);
        near(s.correction[1], expected[i].pitch);
        near(s.correction[2], expected[i].yaw);
        pid_set_dt(.001f);
        pid_update(frames[i], zero, &actual);
        near(actual.roll, expected[i].roll);
        near(actual.pitch, expected[i].pitch);
        near(actual.yaw, expected[i].yaw);
    }

    // Diagnostic start/reset and stop must not reset production integrator or derivative history.
    pid_diag_stop(NULL);
    pid_update(zero, zero, &actual);
    pid_axis_out_t after = actual;
    pid_init();
    for (unsigned i = 0; i < 5; i++) {
        pid_set_dt(.001f);
        pid_update(frames[i], zero, &actual);
    }
    pid_update(zero, zero, &actual);
    near(after.roll, actual.roll);
    near(after.pitch, actual.pitch);
    near(after.yaw, actual.yaw);

    // Receiver mapping is exactly existing rate mapping; no throttle/motor output.
    rc[0] = .5f; rc[1] = -.25f; rc[2] = .8f; rc[3] = 0;
    float demand[3];
    rates_update(rc, demand);
    assert(pid_diag_start(PID_DIAG_SOURCE_RX, NULL));
    tick(1000, zero);
    tick(1000, zero);
    s = snap();
    assert(s.valid);
    for (unsigned i = 0; i < 3; i++) near(s.setpoint_dps[i], demand[i]);
    rx_fresh = false;
    pid_diag_get_snapshot(&s);
    assert(!s.active && !s.valid);
    assert(!strcmp(s.reason, "receiver-stale"));
    near(s.correction[0], 0);
    rx_fresh = true;

    // Timesteps 0, backwards, exact 20ms and over 20ms cannot reuse stale history.
    unsigned gaps[] = {0, 20000, 25000};
    for (unsigned i = 0; i < 3; i++) {
        assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
        tick(1000, g);
        tick(gaps[i], g);
        s = snap();
        assert(!s.valid && !strcmp(s.reason, "dt-invalid"));
        tick(1000, g);
        assert(!snap().valid);
        tick(1000, g);
        assert(snap().valid);
    }
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    now--;
    pid_diag_update(now, g);
    assert(!snap().valid);
    fresh(1000);
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(19999, g);
    assert(snap().valid);

    // Deliberate update of duplicate-is-reset expectation:
    // A current timestamp with repeated sensor sequence is a WAIT, not a reset.
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(1000, g);
    s = snap();
    assert(s.valid && s.sample_seq == 1);
    now += 1000;
    gd.sample_ms = hal_millis();
    pid_diag_update(now, g); // Repeated sample sequence!
    s = snap();
    assert(s.active && !s.valid);
    assert(!strcmp(s.reason, "waiting-new-sample"));
    assert(s.wait_count == 1);
    assert(s.sample_seq == 1); // Sample sequence did not advance
    assert(s.dt_us == 0);
    for (unsigned a = 0; a < 3; a++) {
        assert(s.correction[a] == 0 && s.gyro_dps[a] == 0 && s.error_dps[a] == 0);
    }
    // Next fresh sample accumulates elapsed time (1000us + 1000us = 2000us)
    fresh(1000);
    pid_diag_update(now, g);
    s = snap();
    assert(s.valid && !strcmp(s.reason, "running"));
    assert(s.sample_seq == 2);
    assert(s.dt_us == 2000);

    // Stale timeout when active: stall despite fresh sensor metadata
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(1000, g);
    now += 21000;
    assert(!snap().valid && !snap().active);
    fresh(1);

    // Snapshot validity also expires when producer task stalls
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(1000, g);
    fresh(20000);
    assert(!snap().valid && !strcmp(snap().reason, "diagnostic-stale"));

    // Nonfinite input handling
    float bad[3] = {NAN, 0, 0};
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, bad);
    assert(!snap().valid);
    tick(1000, zero);
    tick(1000, zero);
    assert(snap().valid);

    // Every safety transition stops/invalidates, without arming or motor writes.
    bool *flags[] = {&usb, &healthy, &calibrated, &manual, &motor};
    bool badflag[] = {false, false, false, true, true};
    for (unsigned i = 0; i < 5; i++) {
        fresh(1000);
        assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
        tick(1000, g);
        tick(1000, g);
        bool old = *flags[i];
        *flags[i] = badflag[i];
        s = snap();
        assert(!s.active && !s.valid);
        assert(!pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
        *flags[i] = old;
    }
    fresh(1000);
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    arm = ARM_ARMED;
    s = snap();
    assert(!s.active && !s.valid);
    assert(!pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    arm = ARM_DISARMED;

    fresh(1000);
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    fresh(60000000);
    assert(!snap().active && !strcmp(snap().reason, "session-expired"));

    // Additional tests for isolated I/D continuity, dt aggregation, wait counters & reset reasons
    // 1) Numerical equivalence across wait events:
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, zero);
    tick(2000, g);
    pid_diag_snapshot_t s_direct = snap();

    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, zero);
    now += 500;
    gd.sample_ms = hal_millis();
    pid_diag_update(now, g); // wait event 1 (+500us)
    assert(snap().wait_count == 1);
    now += 500;
    gd.sample_ms = hal_millis();
    pid_diag_update(now, g); // wait event 2 (+500us)
    assert(snap().wait_count == 2);
    fresh(1000); // fresh sample (+1000us) -> total dt = 2000us
    pid_diag_update(now, g);
    pid_diag_snapshot_t s_waited = snap();

    assert(s_waited.valid);
    assert(s_waited.dt_us == 2000);
    near(s_waited.correction[0], s_direct.correction[0]);
    near(s_waited.correction[1], s_direct.correction[1]);
    near(s_waited.correction[2], s_direct.correction[2]);

    // 2) Retained reset reason & category counters
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(1000, g);
    tick(25000, g); // Trigger dt-invalid reset!
    s = snap();
    assert(!s.valid && !strcmp(s.reason, "dt-invalid"));
    assert(!strcmp(s.last_reset_reason, "dt-invalid"));
    assert(s.reset_dt_invalid >= 1);
    // Re-prime and run to active state
    tick(1000, g);
    tick(1000, g);
    s = snap();
    assert(s.valid && !strcmp(s.reason, "running"));
    // Reason is running, but last_reset_reason STILL retains dt-invalid!
    assert(!strcmp(s.last_reset_reason, "dt-invalid"));

    // 3) Sensor sequence wrap-around
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    gd.sample_seq = 0xFFFFFFFF;
    gd.sample_ms = hal_millis();
    now += 1000;
    pid_diag_update(now, g);
    s = snap();
    assert(s.valid);
    gd.sample_seq = 0; // wrap around
    gd.sample_ms = hal_millis();
    now += 1000;
    pid_diag_update(now, g);
    s = snap();
    assert(s.valid);

    // Duplicate/producer boundaries: exactly zero time is invalid, not a wait.
    fresh(1000); assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000,g); tick(1000,g); pid_diag_update(now,g);
    s=snap(); assert(!s.valid && s.reset_dt_invalid==1 && s.wait_count==0);
    // Repeated unchanged hardware sequence cannot stretch the 20ms limit.
    fresh(1000); assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));
    tick(1000,g); tick(1000,g);
    for(unsigned i=0;i<19;i++){now+=1000;pid_diag_update(now,g);s=snap();
        assert(s.active&&!s.valid&&s.wait_count==i+1&&s.reset_count==0);}
    now+=1000;pid_diag_update(now,g);s=snap();
    assert(!s.valid&&s.reset_dt_invalid==1&&s.wait_count==19);
    now+=1000;pid_diag_update(now,g);s=snap();
    assert(!s.active&&!s.valid&&s.reset_gyro_stale==1);
    // Reading status cannot preserve waiting/priming history after a task stall.
    for(unsigned waiting=0;waiting<2;waiting++){
        fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));
        tick(1000,g); if(waiting){tick(1000,g);now+=1000;pid_diag_update(now,g);}
        fresh(20000);s=snap();assert(!s.valid&&s.reset_gyro_stale==1);
        assert(!strcmp(s.last_reset_reason,"diagnostic-stale"));
        tick(1000,g);assert(!snap().valid);tick(1000,g);assert(snap().valid);
        assert(!strcmp(snap().last_reset_reason,"diagnostic-stale"));
    }
    // Explicit stop interrupts a RUNNING session and clears public values.
    pid_diag_stop(NULL);s=snap();assert(!s.active&&!s.valid);
    assert(!strcmp(s.last_reset_reason,"explicit-stop"));
    for(unsigned a=0;a<3;a++)assert(s.correction[a]==0&&s.error_dps[a]==0);
    // Large finite input must still yield a complete bounded telemetry frame.
    fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));
    float huge[3]={FLT_MAX,-FLT_MAX,FLT_MAX};tick(1000,huge);tick(1000,huge);
    pid_diag_cli_process("pid_diag",text,sizeof(text));
    assert(strstr(text,"pid_diag_end: 1\r\n"));assert(strlen(text)<1023);

    // CLI testing
    fresh(1000);
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    tick(1000, g);
    tick(1000, g);
    const char *invalid[] = {"pid_diag start extra", "pid_diag start rx extra", "pid_diagxstart", "start", "pid_diag\narm", "pid_diag start rx;arm"};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        pid_diag_cli_process(invalid[i], text, sizeof(text));
        assert(strstr(text, "refused: invalid-command"));
        assert(snap().active && snap().valid);
    }
    const char *ok[] = {"pid_diag", "pid_diag status", "pid_diag start", "pid_diag start rx", "pid_diag stop"};
    for (unsigned i = 0; i < 5; i++) {
        pid_diag_cli_process(ok[i], text, sizeof(text));
        assert(strstr(text, "pid_diag_end: 1"));
        assert(strstr(text, "motor_output: disabled"));
        assert(strlen(text) < sizeof(text) - 1);
    }
    assert(!snap().active);
    assert(writes == 0);
    assert(arm == ARM_DISARMED);
    puts("PASS shadow PID: original equation equivalence, independent state, rates, freshness/dt/reset guards, session safety, bounded CLI and no motor writes");
    return 0;
}
