/* SPDX-License-Identifier: Apache-2.0 — configured ARM input validity and range matching. */
#include "flight/mode_range.h"
#include "flight/arming.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
static float rc[16];static bool fresh=true,bench=false;static arm_state_t arm=ARM_DISARMED;
const float *rx_channels(void){return rc;}bool rx_frame_fresh(void){return fresh;}bool bench_motor_active(void){return bench;}arm_state_t arming_state(void){return arm;}
bool gyro_manual_calibration_active(void){return false;}
int main(void){
 mode_range_init();assert(mode_range_get(MODE_ARM)->aux_channel==1);assert(!mode_range_is_active(MODE_ARM));rc[4]=1;assert(mode_range_is_active(MODE_ARM));
 assert(mode_range_set(MODE_ARM,true,12,1000,1500));rc[15]=-1;assert(mode_range_is_active(MODE_ARM));rc[15]=0;assert(mode_range_is_active(MODE_ARM));rc[15]=1;assert(!mode_range_is_active(MODE_ARM));
 fresh=false;rc[15]=0;assert(!mode_range_is_active(MODE_ARM));fresh=true;rc[15]=NAN;assert(!mode_range_is_active(MODE_ARM));rc[15]=-2;assert(!mode_range_is_active(MODE_ARM));
 assert(!mode_range_set(MODE_ARM,true,0,1000,1500));assert(!mode_range_set(MODE_ARM,true,13,1000,1500));assert(!mode_range_set(MODE_ARM,true,1,900,2101));assert(!mode_range_set(MODE_ARM,true,1,1500,1500));assert(!mode_range_set(MODE_ARM,true,1,899,1500));assert(mode_range_get(MODE_ARM)->aux_channel==12);
 arm=ARM_ARMED;assert(!mode_range_set(MODE_ARM,true,1,1000,2000));arm=ARM_DISARMED;bench=true;assert(!mode_range_set(MODE_ARM,true,1,1000,2000));bench=false;
 assert(mode_range_set(MODE_ARM,false,12,1000,1500));rc[15]=0;assert(!mode_range_is_active(MODE_ARM));mode_range_reset();assert(mode_range_get(MODE_ARM)->aux_channel==1);assert(mode_range_get(MODE_ANGLE)->aux_channel==2);
 bool active=true;uint32_t rev=mode_range_arm_revision();
 assert(mode_range_set(MODE_ARM,true,1,1751,2100));assert(mode_range_arm_revision()!=rev);
 for(unsigned aux=1;aux<=12;aux++){
  assert(mode_range_set(MODE_ARM,true,aux,1751,2100));rc[3+aux]=-1;
  assert(mode_range_arm_input(&active)&&!active);rc[3+aux]=1;
  assert(mode_range_arm_input(&active)&&active);
 }
 rc[15]=NAN;assert(!mode_range_arm_input(&active)&&!active);
 rc[15]=2;assert(!mode_range_arm_input(&active)&&!active);
 rc[15]=1;fresh=false;assert(!mode_range_arm_input(&active)&&!active);fresh=true;
 bench=true;assert(mode_range_arm_input(&active)&&active);assert(!mode_range_is_active(MODE_ARM));
 arm=ARM_ARMED;assert(mode_range_is_active(MODE_ARM));arm=ARM_DISARMED;bench=false;
 rev=mode_range_arm_revision();assert(mode_range_set(MODE_ARM,false,12,1751,2100));assert(mode_range_arm_revision()!=rev);
 assert(!mode_range_arm_input(&active)&&!active);assert(!mode_range_arm_input(NULL));
 puts("PASS configured ARM input and preview ranges: AUX1=rc[4], AUX12=rc[15], bounds, invalid input, freshness, disabled, edit guards, reset");
}
