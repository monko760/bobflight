/* SPDX-License-Identifier: Apache-2.0
 * Complementary roll/pitch estimator and angle-to-rate outer loop, degrees.
 * Limited-tilt prototype; no altitude hold or yaw heading hold. */
#include "flight/attitude.h"
#include <math.h>
static float angle[3];static bool ready;
void attitude_init(void){angle[0]=angle[1]=angle[2]=0;ready=false;}
const float *attitude_degrees(void){return angle;}
bool attitude_ready(void){return ready;}
bool attitude_update(const float gyro[3],const float acc[3],float dt){
    if(!gyro || !acc || !isfinite(dt) || dt<=0 || dt>0.02f){ready=false;return false;}
    for(unsigned i=0;i<3;i++)if(!isfinite(gyro[i]) || !isfinite(acc[i])){ready=false;return false;}
    const float rad=0.01745329252f,deg=57.29577951f;
    float norm=acc[0]*acc[0]+acc[1]*acc[1]+acc[2]*acc[2];
    bool gravity=norm>0.64f && norm<1.44f;
    float roll=atan2f(acc[1],acc[2])*deg;
    float pitch=atan2f(-acc[0],sqrtf(acc[1]*acc[1]+acc[2]*acc[2]))*deg;
    if(!ready){if(!gravity)return false;angle[0]=roll;angle[1]=pitch;ready=true;}
    float sr=sinf(angle[0]*rad),cr=cosf(angle[0]*rad),cp=cosf(angle[1]*rad);
    if(fabsf(cp)<0.1f){ready=false;return false;}
    angle[0]+=(gyro[0]+(gyro[1]*sr+gyro[2]*cr)*tanf(angle[1]*rad))*dt;
    angle[1]+=(gyro[1]*cr-gyro[2]*sr)*dt;
    if(gravity){float alpha=dt/(0.5f+dt);float error=roll-angle[0];while(error>180)error-=360;while(error< -180)error+=360;angle[0]+=alpha*error;angle[1]+=alpha*(pitch-angle[1]);}
    while(angle[0]>180)angle[0]-=360;
    while(angle[0]< -180)angle[0]+=360;
    return true;
}
void attitude_setpoint(const float sticks[4],float out[3]){
    out[0]=4.f*(sticks[0]*25.f-angle[0]);out[1]=4.f*(sticks[1]*25.f-angle[1]);out[2]=sticks[2]*200.f;
    for(unsigned i=0;i<3;i++){if(out[i]>200)out[i]=200;if(out[i]< -200)out[i]=-200;}
}
