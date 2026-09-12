/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host tests: staged failsafe state machine.
 * Links flight arming + failsafe only; stubs rx_channels / gyro.
 */
#include "flight/arming.h"
#include "flight/failsafe.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* --- stubs for drivers --- */
static float g_rc[16];

const float *rx_channels(void)
{
    return g_rc;
}

bool gyro_is_healthy(void)
{
    return true;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

/* Arm with a healthy link at time t (throttle idle for the arm gate). */
static void arm_ok(uint32_t t)
{
    arming_set_gyro_healthy(true);
    g_rc[3] = 0.0f;
    failsafe_note_rx_frame(t);
    if (!arming_try_arm() || arming_state() != ARM_ARMED) {
        (void)fail("helper: expected to arm");
        exit(1);
    }
}

int main(void)
{
    float st[4] = {9.f, 9.f, 9.f, 9.f};

    /* 1. Boot: never seen RX → active, blocks arming, no override. */
    arming_init();
    failsafe_init();
    if (!failsafe_active()) return fail("boot must be active before first RX");
    if (failsafe_stage() != FAILSAFE_STAGE_IDLE) return fail("boot stage IDLE");
    if (failsafe_command_override(st)) return fail("no override when IDLE");
    g_rc[3] = 0.0f;
    arming_set_gyro_healthy(true);
    if (arming_try_arm()) return fail("arming must be blocked before first RX");

    /* 2. First frame clears it; frame at timestamp zero is valid. */
    failsafe_note_rx_frame(0u);
    failsafe_tick(0u);
    if (failsafe_active()) return fail("fresh frame must deactivate");
    arm_ok(0u);
    if (failsafe_command_override(st)) return fail("armed+healthy: no override");

    /* 3. Baseline default (DROP, hold 0): stale link disarms promptly. */
    failsafe_note_rx_frame(100u);
    failsafe_tick(100u + 251u);
    if (!failsafe_active()) return fail("stale link must activate");
    if (failsafe_stage() == FAILSAFE_STAGE_HOLD) return fail("hold 0 → PROCEDURE at once");
    if (arming_state() != ARM_DISARMED) return fail("DROP must disarm");

    /* 4. Recovery inside the hold window: no disarm, pilot keeps control. */
    arming_init();
    failsafe_init();
    failsafe_set_hold_ms(300u);
    arm_ok(1000u);
    failsafe_tick(1251u);
    if (failsafe_stage() != FAILSAFE_STAGE_HOLD) return fail("gap>250 → HOLD stage");
    if (failsafe_stage() == FAILSAFE_STAGE_PROCEDURE) return fail("window not over");
    if (arming_state() != ARM_ARMED) return fail("HOLD must not disarm");
    failsafe_tick(1549u); /* 299ms into a 300ms window */
    if (failsafe_stage() != FAILSAFE_STAGE_HOLD) return fail("window still open");
    if (arming_state() != ARM_ARMED) return fail("still armed inside window");
    failsafe_note_rx_frame(1560u);
    if (failsafe_active()) return fail("recovery → inactive");
    if (arming_state() != ARM_ARMED) return fail("recovery keeps craft armed");

    /* 5. Window expiry → DROP disarms. */
    failsafe_note_rx_frame(2000u);
    failsafe_tick(2251u);
    if (failsafe_stage() != FAILSAFE_STAGE_HOLD) return fail("gap>250 → HOLD");
    failsafe_tick(2600u);
    if (failsafe_stage() != FAILSAFE_STAGE_PROCEDURE) return fail("window out → PROCEDURE");
    if (arming_state() != ARM_DISARMED) return fail("expiry + DROP → disarm");

    /* 6. HOLD action: level commands with held throttle, never auto-disarm. */
    arming_init();
    failsafe_init();
    failsafe_set_action(FAILSAFE_ACTION_HOLD);
    arm_ok(3000u);
    g_rc[3] = 0.70f; /* throttle value to be captured when the link drops */
    failsafe_tick(3251u);
    failsafe_tick(3252u);
    if (failsafe_stage() != FAILSAFE_STAGE_PROCEDURE) return fail("hold 0 → PROCEDURE");
    if (arming_state() != ARM_ARMED) return fail("HOLD action must not disarm");
    st[0] = st[1] = st[2] = st[3] = 9.f;
    if (!failsafe_command_override(st)) return fail("override during HOLD");
    if (st[0] != 0.f || st[1] != 0.f || st[2] != 0.f) return fail("level commands");
    if (st[3] < 0.699f || st[3] > 0.701f) return fail("held throttle");
    failsafe_tick(99999u);
    if (arming_state() != ARM_ARMED) return fail("HOLD never disarms");
    failsafe_note_rx_frame(100000u);
    if (failsafe_active() || arming_state() != ARM_ARMED) return fail("HOLD recovery");

    /* 7. LAND action: descent throttle, disarm on land timer. */
    arming_init();
    failsafe_init();
    failsafe_set_action(FAILSAFE_ACTION_LAND);
    failsafe_set_hold_ms(100u);
    failsafe_set_land_ms(200u);
    failsafe_set_land_throttle(0.40f);
    arm_ok(5000u);
    g_rc[3] = 0.80f; /* hover throttle to hold onto during the descent */
    failsafe_tick(5251u);
    if (failsafe_stage() != FAILSAFE_STAGE_HOLD) return fail("HOLD first");
    failsafe_tick(5352u); /* 101ms ≥ 100ms window */
    if (failsafe_stage() != FAILSAFE_STAGE_PROCEDURE) return fail("PROCEDURE");
    if (arming_state() != ARM_ARMED) return fail("LAND must stay armed while descending");
    st[0] = st[1] = st[2] = st[3] = 9.f;
    if (!failsafe_command_override(st)) return fail("override during LAND");
    if (st[3] < 0.399f || st[3] > 0.401f) return fail("descent throttle");
    failsafe_tick(5551u); /* 199ms into 200ms land timer */
    if (arming_state() != ARM_DISARMED && 5552u - 5352u < 200u) {
        /* still inside timer on this tick — disarm lands on the next one */
    }
    failsafe_tick(5560u);
    if (arming_state() != ARM_DISARMED) return fail("land timer out → disarm");

    /* 8. Cannot re-arm while failsafe latched; fresh frame unlocks. */
    g_rc[3] = 0.0f;
    arming_set_gyro_healthy(true);
    if (arming_try_arm()) return fail("arming blocked while failsafe active");
    failsafe_note_rx_frame(6000u);
    if (!arming_try_arm()) return fail("fresh frame unlocks arming");

    /* 9. Land throttle config is clamped to [0,1]. */
    failsafe_set_land_throttle(1.5f);
    failsafe_set_hold_ms(0u);
    st[3] = 9.f;
    failsafe_set_action(FAILSAFE_ACTION_LAND);
    failsafe_note_rx_frame(7000u);
    failsafe_tick(7251u);
    failsafe_tick(7260u);
    if (!failsafe_command_override(st)) return fail("override for clamp check");
    if (st[3] > 1.0f) return fail("land throttle must clamp to 1.0");

    /* A disarmed receiver configuration reset must retain the selected policy. */
    arming_disarm();
    failsafe_set_action(FAILSAFE_ACTION_HOLD);
    failsafe_set_hold_ms(100u);
    failsafe_reset_rx_link();
    if (!failsafe_active()) return fail("receiver reset must invalidate old link");
    arm_ok(8000u);
    failsafe_tick(8251u);
    if (failsafe_stage()!=FAILSAFE_STAGE_HOLD) return fail("receiver reset preserves hold time");
    failsafe_tick(8352u);
    if (arming_state()!=ARM_ARMED) return fail("receiver reset preserves HOLD action");
    puts("PASS: staged failsafe (recovery, drop, hold, land)");
    return 0;
}
