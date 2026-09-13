/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef enum {
    ARM_DISARMED = 0,
    ARM_ARMED = 1
} arm_state_t;

static arm_state_t g_arm_state = ARM_DISARMED;
static bool g_bench_motor_active = false;
static bool g_gyro_manual_cal_active = false;
static bool g_bootloader_supported = true;
static bool g_persist_dirty = false;
static uint32_t g_millis = 1000;
static bool g_hal_bootloader_request_return = false;
static int g_bootloader_request_calls = 0;
static int g_persist_save_calls = 0;

bool persist_save(void) { g_persist_save_calls++; return true; }

static char g_cli_output[2048];

static void cli_write_str(const char *s) {
    strncat(g_cli_output, s, sizeof(g_cli_output) - strlen(g_cli_output) - 1);
}

static arm_state_t arming_state(void) { return g_arm_state; }
static bool bench_motor_active(void) { return g_bench_motor_active; }
static bool gyro_manual_calibration_active(void) { return g_gyro_manual_cal_active; }
static bool hal_bootloader_supported(void) { return g_bootloader_supported; }
static bool persist_dirty(void) { return g_persist_dirty; }
static uint32_t hal_millis(void) { return g_millis; }

static bool hal_bootloader_request(void) {
    g_bootloader_request_calls++;
    return g_hal_bootloader_request_return;
}

#include "drivers/bootloader_cli.h"

static void reset_mocks(void) {
    g_arm_state = ARM_DISARMED;
    g_bench_motor_active = false;
    g_gyro_manual_cal_active = false;
    g_bootloader_supported = true;
    g_persist_dirty = false;
    g_millis = 1000;
    g_hal_bootloader_request_return = false;
    g_bootloader_request_calls = 0;
    g_persist_save_calls = 0;
    g_cli_output[0] = '\0';
    bl_pending = false;
    bl_discard = false;
    bl_started = 0;
}

static void test_command_parsing_and_case(void) {
    reset_mocks();

    /* Unrecognized commands */
    assert(cmd_bootloader("help") == false);
    assert(cmd_bootloader("bl_discard") == false);
    assert(cmd_bootloader("bl extra") == false);
    assert(cmd_bootloader("discard") == false);

    /* Valid variants */
    reset_mocks();
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == true);
    assert(bl_discard == false);
    assert(strstr(g_cli_output, "bl: resetting to ST ROM bootloader") != NULL);

    reset_mocks();
    assert(cmd_bootloader("BL") == true);
    assert(bl_pending == true);

    reset_mocks();
    assert(cmd_bootloader("bL") == true);
    assert(bl_pending == true);

    reset_mocks();
    assert(cmd_bootloader("Bl") == true);
    assert(bl_pending == true);

    reset_mocks();
    assert(cmd_bootloader("bl discard") == true);
    assert(bl_pending == true);
    assert(bl_discard == true);

    reset_mocks();
    assert(cmd_bootloader("BL DISCARD") == true);
    assert(bl_pending == true);
    assert(bl_discard == true);

    reset_mocks();
    assert(cmd_bootloader("bL dIsCaRd") == true);
    assert(bl_pending == true);
    assert(bl_discard == true);
}

static void test_safety_refusals(void) {
    /* Armed refusal */
    reset_mocks();
    g_arm_state = ARM_ARMED;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == false);
    assert(strstr(g_cli_output, "bl refused: disarm, bench_stop and finish/cancel manual calibration") != NULL);

    /* Bench active refusal */
    reset_mocks();
    g_bench_motor_active = true;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == false);
    assert(strstr(g_cli_output, "bl refused: disarm, bench_stop and finish/cancel manual calibration") != NULL);

    /* Manual calibration active refusal */
    reset_mocks();
    g_gyro_manual_cal_active = true;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == false);
    assert(strstr(g_cli_output, "bl refused: disarm, bench_stop and finish/cancel manual calibration") != NULL);
}

static void test_discard_never_bypasses_safety(void) {
    for (unsigned reason=0; reason<4; ++reason) {
        reset_mocks(); g_persist_dirty=true;
        if(reason==0) g_arm_state=ARM_ARMED;
        if(reason==1) g_bench_motor_active=true; /* also represents a waiting AUX session */
        if(reason==2) g_gyro_manual_cal_active=true;
        if(reason==3) g_bootloader_supported=false;
        assert(cmd_bootloader("BL DISCARD"));
        assert(!bl_pending && g_bootloader_request_calls==0);
    }
}

static void test_unsupported_refusal(void) {
    reset_mocks();
    g_bootloader_supported = false;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == false);
    assert(strstr(g_cli_output, "bl unavailable: unsupported board/MCU or invalid ROM vectors") != NULL);
}

static void test_dirty_refusal_and_discard(void) {
    /* Plain 'bl' refused when dirty */
    reset_mocks();
    g_persist_dirty = true;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == false);
    assert(strstr(g_cli_output, "bl refused: unsaved configuration") != NULL);

    /* 'bl discard' accepted when dirty (only bypass dirty) */
    reset_mocks();
    g_persist_dirty = true;
    assert(cmd_bootloader("bl discard") == true);
    assert(bl_pending == true);
    assert(bl_discard == true);
    assert(strstr(g_cli_output, "bl: resetting to ST ROM bootloader") != NULL);
}

static void test_100ms_boundary_and_uint32_wrap(void) {
    /* Standard 100ms nonblocking boundary test */
    reset_mocks();
    g_millis = 1000;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == true);

    /* poll at elapsed 0ms -> no request */
    bootloader_poll();
    assert(bl_pending == true);
    assert(g_bootloader_request_calls == 0);

    /* poll at elapsed 99ms -> no request */
    g_millis = 1099;
    bootloader_poll();
    assert(bl_pending == true);
    assert(g_bootloader_request_calls == 0);

    /* poll at elapsed 100ms -> request executed! */
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 1);

    /* uint32 millis wrap-around test */
    reset_mocks();
    g_millis = 0xFFFFFFF0u;
    assert(cmd_bootloader("bl") == true);
    assert(bl_pending == true);

    /* poll after wrap: 0x00000022u - 0xFFFFFFF0u = 50ms */
    g_millis = 0x00000022u;
    bootloader_poll();
    assert(bl_pending == true);
    assert(g_bootloader_request_calls == 0);

    /* poll after wrap: 0x00000053u - 0xFFFFFFF0u = 99ms */
    g_millis = 0x00000053u;
    bootloader_poll();
    assert(bl_pending == true);
    assert(g_bootloader_request_calls == 0);

    /* poll after wrap: 0x00000054u - 0xFFFFFFF0u = 100ms -> triggers reset */
    g_millis = 0x00000054u;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 1);
}

static void test_state_change_cancel_during_wait(void) {
    /* Armed state change during wait -> cancel */
    reset_mocks();
    g_millis = 1000;
    cmd_bootloader("bl");
    g_millis = 1050;
    g_arm_state = ARM_ARMED;
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 0);
    assert(strstr(g_cli_output, "bl cancelled: safety/configuration state changed") != NULL);

    /* Bench active state change during wait -> cancel */
    reset_mocks();
    g_millis = 1000;
    cmd_bootloader("bl");
    g_millis = 1050;
    g_bench_motor_active = true;
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 0);
    assert(strstr(g_cli_output, "bl cancelled: safety/configuration state changed") != NULL);

    /* Manual cal state change during wait -> cancel */
    reset_mocks();
    g_millis = 1000;
    cmd_bootloader("bl");
    g_millis = 1050;
    g_gyro_manual_cal_active = true;
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 0);
    assert(strstr(g_cli_output, "bl cancelled: safety/configuration state changed") != NULL);
}

static void test_dirty_change_cancel_unless_discard(void) {
    /* Clean when scheduled, becomes dirty during wait -> cancel */
    reset_mocks();
    g_persist_dirty = false;
    g_millis = 1000;
    cmd_bootloader("bl");
    g_millis = 1050;
    g_persist_dirty = true;
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 0);
    assert(strstr(g_cli_output, "bl cancelled: safety/configuration state changed") != NULL);

    /* Clean when scheduled with 'bl discard', becomes dirty during wait -> proceed anyway */
    reset_mocks();
    g_persist_dirty = false;
    g_millis = 1000;
    cmd_bootloader("bl discard");
    g_millis = 1050;
    g_persist_dirty = true;
    g_millis = 1100;
    bootloader_poll();
    assert(bl_pending == false);
    assert(g_bootloader_request_calls == 1);
}

static void test_no_autosave_and_returned_hal_failure(void) {
    /* hal_bootloader_request returns (failure) */
    reset_mocks();
    g_millis = 1000;
    cmd_bootloader("bl");
    g_millis = 1100;
    bootloader_poll();
    assert(g_bootloader_request_calls == 1);
    assert(g_persist_save_calls == 0);
    assert(strstr(g_cli_output, "bl failed: bootloader reset unavailable; normal firmware retained") != NULL);
    assert(strstr(g_cli_output, "no automatic save") != NULL);
}

int main(void) {
    test_command_parsing_and_case();
    test_safety_refusals();
    test_unsupported_refusal();
    test_discard_never_bypasses_safety();
    test_dirty_refusal_and_discard();
    test_100ms_boundary_and_uint32_wrap();
    test_state_change_cancel_during_wait();
    test_dirty_change_cancel_unless_discard();
    test_no_autosave_and_returned_hal_failure();
    puts("PASS host_bootloader_cli");
    return 0;
}
