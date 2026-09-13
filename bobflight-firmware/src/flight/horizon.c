/* SPDX-License-Identifier: Apache-2.0
 * Clean-room experimental Horizon: shared roll/pitch deflection blend.
 * No dt dependence, hidden state, or change to the attitude estimator. */
#include "flight/horizon.h"
#include "flight/attitude.h"
#include "flight/rates.h"
#include <math.h>
float horizon_rate_weight(const float sticks[4]) {
    if(!sticks || !isfinite(sticks[0]) || !isfinite(sticks[1]))return 0.f;
    float d=fmaxf(fabsf(sticks[0]),fabsf(sticks[1]));
    if(d<=0.1f)return 0.f;
    if(d>=1.f)return 1.f;
    return (d-0.1f)/0.9f;
}
void horizon_setpoint(const float sticks[4],float out[3]) {
    if(!out)return;
    if(!sticks){out[0]=out[1]=out[2]=0.f;return;}
    for(unsigned i=0;i<4;i++)if(!isfinite(sticks[i])){out[0]=out[1]=out[2]=0.f;return;}
    /* Both are rate demands in degrees/second, before ONE inner rate PID. */
    float angle[3],rate[3];
    attitude_setpoint(sticks,angle);rates_update(sticks,rate);
    const float w=horizon_rate_weight(sticks);
    for(unsigned i=0;i<2;i++)out[i]=(1.f-w)*angle[i]+w*rate[i];
    out[2]=rate[2]; /* Yaw is rate control, independent of the leveling blend. */
}
