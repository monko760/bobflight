/* Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 * Real task-loop bench state machine with deterministic clock and mock outputs.
 * These tests do not validate physical timer/DMA operation or motor behavior.
 */
#include "sched/tasks.h"
#include "drivers/bench_parse.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/rx.h"
#include "drivers/cli.h"
#include "hal/hal.h"
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static uint64_t now;
static bool usb = true, healthy = true, calibrating = false;
bool gyro_manual_calibration_active(void) { return calibrating; }
void gyro_calibration_tick(void) {}
static arm_state_t arm = ARM_DISARMED;
static float motors[4], rc[16], accel[3] = {0, 0, 0.82f}, input_gyro[3] = {10, -20, 30};
static unsigned motor_calls;
static gyro_diagnostics_t gd = {.config_ok = true};
bool gyro_is_healthy(void) { return healthy; }
const gyro_diagnostics_t *gyro_diagnostics(void) { return &gd; }
uint32_t hal_millis(void) { return (uint32_t)(now / 1000u); }
uint64_t hal_micros(void) { return now; }
bool hal_usb_cdc_connected(void) { return usb; }
arm_state_t arming_state(void) { return arm; }
void arming_disarm(void) { arm = ARM_DISARMED; }
bool arming_try_arm(void) { return false; }
const float *rx_channels(void) { return rc; }
bool rx_frame_fresh(void) { return true; }
void rx_poll(void) {}
void cli_poll(void) {}
void failsafe_tick(uint32_t t) { (void)t; }
bool failsafe_command_override(float s[4]) { (void)s; return false; }
bool gyro_sample(float d[3]) { memcpy(d, input_gyro, sizeof(input_gyro)); gd.sample_ms = hal_millis(); gd.sample_seq++; return true; }
void gyro_filter(const float in[3], float out[3]) { memcpy(out, in, 3 * sizeof(float)); }
const float *gyro_accel_g(void) { return accel; }
bool gyro_calibrated(void) { return true; }
bool dshot_is_healthy(void) { return healthy; }
void dshot_write(const float m[4]) { motor_calls++; memcpy(motors, m, sizeof(motors)); }

#include "flight/pid_diag.h"
#include "flight/config.h"
#include <assert.h>
#include <math.h>

static void cycle(unsigned us) { now += us; loop_gyro(); loop_filter(); loop_pid(); loop_mixer_dshot(); }
static pid_diag_snapshot_t snapshot(void) { pid_diag_snapshot_t s; pid_diag_get_snapshot(&s); return s; }

int main(void) {
    config_init();
    pid_diag_init();
    rc[4] = -1.f;
    cycle(1000);
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    cycle(1000);
    assert(!snapshot().valid);
    cycle(1000);
    pid_diag_snapshot_t s = snapshot();
    assert(s.valid && s.dt_us == 1000 && s.correction[0] < 0 && s.correction[1] > 0);

    // Bad gravity does not gate rate diagnostics, and still does not permit flight.
    assert(arm == ARM_DISARMED);
    for (unsigned j = 0; j < 4; j++) assert(motors[j] == 0.f);
    for (unsigned i = 0; i < 25; i++) {
        cycle(1000);
        assert(snapshot().valid);
        for (unsigned j = 0; j < 4; j++) assert(motors[j] == 0.f);
    }
    assert(motor_calls == 28); // Only existing cascade sends its ordinary zero frames.

    // Task loop task-level duplicate sequence (wait event) test:
    now += 1000;
    loop_filter();
    loop_pid(); // pid_diag_update called with repeated sample_seq
    s = snapshot();
    assert(s.active && !s.valid && !strcmp(s.reason, "waiting-new-sample"));
    assert(s.wait_count == 1);
    cycle(1000); // next fresh cycle
    s = snapshot();
    assert(s.active && s.valid && !strcmp(s.reason, "running") && s.dt_us == 2000);

    cycle(20000);
    assert(!snapshot().valid);
    cycle(1000);
    assert(!snapshot().valid);
    cycle(1000);
    assert(snapshot().valid);

    usb = false;
    cycle(1000);
    assert(!snapshot().active);
    usb = true;
    cycle(1000);
    assert(!snapshot().active);

    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    cycle(1000);
    cycle(1000);
    calibrating = true;
    cycle(1000);
    assert(!snapshot().active);
    calibrating = false;

    // This call exercises mutual exclusion in fake IO only, never on hardware.
    assert(pid_diag_start(PID_DIAG_SOURCE_ZERO, NULL));
    assert(bench_motor_pulse(1, 8));
    cycle(1000);
    assert(!snapshot().active);
    assert(bench_motor_test(0));
    cycle(1000);

    for (unsigned j = 0; j < 4; j++) assert(motors[j] == 0.f);
    assert(arm == ARM_DISARMED);
    puts("PASS real task cascade + shadow PID: bad-accel independence, measured dt, existing zero output, disconnect/calibration/motor exclusion; no physical motor test");
    return 0;
}
