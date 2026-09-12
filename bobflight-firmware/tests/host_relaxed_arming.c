/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "flight/arming.h"
#include "flight/failsafe.h"
#include <stdbool.h>
#include <stdio.h>
static float rc[16];
bool gyro_is_healthy(void){return true;}
bool gyro_flight_ready(void){return true;} /* Even if readiness is incorrectly asserted. */
bool rx_frame_fresh(void){return true;}
const float *rx_channels(void){return rc;}
int main(void){
 arming_init();failsafe_init();failsafe_note_rx_frame(0);failsafe_tick(0);arming_set_gyro_healthy(true);
 if(failsafe_active() || arming_try_arm() || arming_state()!=ARM_DISARMED)return 1;
 puts("PASS relaxed bench refuses arming despite healthy gyro, fresh RX, low throttle and ready stub");return 0;
}
