/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: drivers/motor_direction_cli.h with the real config + mixer.
 * Exact replies for get/set/refusals and the `mixer` report; refused sets
 * (armed, motor test running, bad token) leave the setting unchanged.
 */
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "flight/arming.h"
#include "sched/tasks.h"
static char output[1024];
static bool armed, bench;
static void cli_write_str(const char *s) { assert(strlen(output) + strlen(s) < sizeof output); strcat(output, s); }
arm_state_t arming_state(void) { return armed ? ARM_ARMED : ARM_DISARMED; }
bool bench_motor_active(void) { return bench; }
#include "drivers/motor_direction_cli.h"

static const char *set(const char *v) { output[0] = 0; assert(cmd_set_motor_direction("motor_direction", v)); return output; }
static const char *get(void) { output[0] = 0; assert(cmd_get_motor_direction("motor_direction")); return output; }
static const char *mixer(void) { output[0] = 0; cmd_mixer(); return output; }

int main(void)
{
    config_init();
    assert(!cmd_set_motor_direction("motor_poles", "14") && !cmd_get_motor_direction("motor_poles") && !output[0]);
    assert(!strcmp(get(), "motor_direction=props-out\r\n"));
    assert(!strcmp(mixer(), "mixer_api: 1\r\nmixer: quadx\r\nmotor_direction: props-out\r\n"
                            "mixer_yaw_m1: -1\r\nmixer_yaw_m2: +1\r\nmixer_yaw_m3: +1\r\nmixer_yaw_m4: -1\r\nmixer_end: 1\r\n"));
    assert(!strcmp(set("props-in"), "ok motor_direction=props-in\r\n"));
    assert(!strcmp(get(), "motor_direction=props-in\r\n"));
    assert(!strcmp(mixer(), "mixer_api: 1\r\nmixer: quadx\r\nmotor_direction: props-in\r\n"
                            "mixer_yaw_m1: +1\r\nmixer_yaw_m2: -1\r\nmixer_yaw_m3: -1\r\nmixer_yaw_m4: +1\r\nmixer_end: 1\r\n"));
    /* Refusals, in order: armed, then motor test, then token. Setting unchanged. */
    armed = true; bench = true;
    assert(!strcmp(set("props-out"), "set failed: armed\r\n") && config_motor_direction() == MOTOR_DIRECTION_PROPS_IN);
    armed = false;
    assert(!strcmp(set("props-out"), "set failed: motor test running\r\n") && config_motor_direction() == MOTOR_DIRECTION_PROPS_IN);
    assert(!strcmp(set("sideways"), "set failed: motor test running\r\n"));
    bench = false;
    static const char *const bad[] = {"sideways", "PROPS-OUT", "props_out", "", "props-out ", "0"};
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++)
        assert(!strcmp(set(bad[i]), "set failed: motor_direction must be props-out or props-in\r\n") && config_motor_direction() == MOTOR_DIRECTION_PROPS_IN);
    output[0] = 0; assert(cmd_set_motor_direction("motor_direction", NULL));
    assert(!strcmp(output, MOTOR_DIRECTION_INVALID_LINE "\r\n"));
    assert(!strcmp(set("props-out"), "ok motor_direction=props-out\r\n") && config_motor_direction() == MOTOR_DIRECTION_PROPS_OUT);
    assert(!strcmp(MOTOR_DIRECTION_ARMED_LINE, "set failed: armed"));
    assert(!strcmp(MOTOR_DIRECTION_MOTOR_TEST_LINE, "set failed: motor test running"));
    puts("PASS motor_direction CLI unit: get/set/mixer report exact, armed / motor test running / bad token refusals verbatim and in order, setting unchanged");
    return 0;
}
