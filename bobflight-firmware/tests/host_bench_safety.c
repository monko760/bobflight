/* Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 * Real task-loop bench state machine with deterministic clock and mock outputs.
 * These tests do not validate physical timer/DMA operation or motor behavior.
 */
#include "sched/tasks.h"
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

static uint32_t now;
static bool usb=true, healthy=true;
static arm_state_t arm=ARM_DISARMED;
static float motors[4], rc[16], accel[3]={0,0,1};
uint32_t hal_millis(void){return now;}
uint64_t hal_micros(void){return (uint64_t)now*1000u;}
bool hal_usb_cdc_connected(void){return usb;}
arm_state_t arming_state(void){return arm;}
void arming_disarm(void){arm=ARM_DISARMED;}
bool arming_try_arm(void){return false;}
const float *rx_channels(void){return rc;}
void rx_poll(void){}
void cli_poll(void){}
void failsafe_tick(uint32_t t){(void)t;}
bool failsafe_command_override(float s[4]){(void)s;return false;}
bool gyro_sample(float d[3]){memset(d,0,3*sizeof(float));return true;}
void gyro_filter(const float in[3],float out[3]){memcpy(out,in,3*sizeof(float));}
const float *gyro_accel_g(void){return accel;}
bool gyro_calibrated(void){return true;}
bool dshot_is_healthy(void){return healthy;}
void dshot_write(const float m[4]){memcpy(motors,m,sizeof(motors));}

#define CHECK(c) do { if(!(c)){fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#c);return 1;} } while(0)
static bool output(unsigned motor){
    for(unsigned i=0;i<4;i++)if(motors[i]!=(motor==i+1?0.08f:0.f))return false;
    return true;
}
static void reset(void){
    usb=true;healthy=true;arm=ARM_DISARMED;
    bench_motor_test(0);loop_mixer_dshot();
}
int main(void){
    reset();
    CHECK(!bench_motor_active());
    /* A single test replaces a sequence and must not advance to another motor. */
    now=0; CHECK(bench_motor_seq_start());loop_mixer_dshot();CHECK(output(1));
    now=100;CHECK(bench_motor_test(4));loop_mixer_dshot();CHECK(output(4));
    now=1100;loop_mixer_dshot();CHECK(output(0));CHECK(!bench_motor_active());
    now=2000;loop_mixer_dshot();CHECK(output(0));
    /* Stop stays busy until a stop frame has been submitted by the cascade. */
    CHECK(bench_motor_test(2));loop_mixer_dshot();CHECK(output(2));
    CHECK(bench_motor_test(0));CHECK(bench_motor_active());
    loop_mixer_dshot();CHECK(output(0));CHECK(!bench_motor_active());
    /* Sequence gaps remain locked, including the last gap, until completion. */
    now=3000;CHECK(bench_motor_seq_start());CHECK(bench_motor_active());
    for(unsigned motor=1;motor<=4;motor++){
        loop_mixer_dshot();CHECK(output(motor));
        now+=1000;loop_mixer_dshot();CHECK(output(0));CHECK(bench_motor_active());
        now+=699;loop_mixer_dshot();CHECK(output(0));CHECK(bench_motor_active());
        now++;loop_mixer_dshot();CHECK(output(0));
    }
    CHECK(!bench_motor_active());
    /* Loss of USB/driver health cancels, and reconnect does not resume. */
    CHECK(bench_motor_seq_start());loop_mixer_dshot();usb=false;
    loop_mixer_dshot();CHECK(output(0));CHECK(!bench_motor_active());
    CHECK(!bench_motor_test(1));CHECK(!bench_motor_seq_start());
    usb=true;now+=2000;loop_mixer_dshot();CHECK(output(0));
    CHECK(bench_motor_seq_start());loop_mixer_dshot();healthy=false;
    loop_mixer_dshot();CHECK(output(0));CHECK(!bench_motor_active());
    CHECK(!bench_motor_test(1));CHECK(!bench_motor_seq_start());
    reset();arm=ARM_ARMED;
    CHECK(!bench_motor_test(1));CHECK(!bench_motor_seq_start());
    reset();CHECK(!bench_motor_test(5));
    /* Pulse timeout is wrap-safe for the uint32 millisecond clock. */
    now=UINT32_MAX-500u;CHECK(bench_motor_test(3));loop_mixer_dshot();CHECK(output(3));
    now+=999u;loop_mixer_dshot();CHECK(output(3));
    now++;loop_mixer_dshot();CHECK(output(0));CHECK(!bench_motor_active());
    puts("PASS: bench cancellation, stop lock, sequence gaps, disconnect, health, arm gate, rollover");
    return 0;
}
