/* SPDX-License-Identifier: Apache-2.0
 * Quaternion complementary roll/pitch estimator and angle-to-rate outer loop, degrees.
 * The body-to-earth quaternion has no pitch singularity: pitch through +/-90 deg and
 * full flips/rolls stay valid (N1). Euler roll/pitch/yaw are derived only as outputs.
 * Gyro-relative yaw is telemetry only, not an absolute heading or heading hold.
 * Limited-tilt prototype; no altitude hold or yaw heading hold. */
#include "flight/attitude.h"
#include <math.h>
static float q[4]={1.f,0.f,0.f,0.f}; /* w x y z, body to earth (x fwd, y right, z down) */
static float angle[3];
static attitude_state_t state;
static float gravity_age_s,recover_s;
/* Accelerometer correction gains, rad/s per rad of tilt error. 2 rad/s keeps the
 * previous 0.5 s complementary time constant; recovery converges faster. */
static const float kp_normal=2.f,kp_recover=10.f;
static const float rad=0.01745329252f,deg=57.29577951f;
static void normalize_q(void){
    float n=sqrtf(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]);
    if(!(n>1e-6f) || !isfinite(n)){q[0]=1.f;q[1]=q[2]=q[3]=0.f;return;}
    for(unsigned i=0;i<4;i++)q[i]/=n;
}
static void euler_from_q(void){
    const float w=q[0],x=q[1],y=q[2],z=q[3];
    float sp=2.f*(w*y-z*x);if(sp>1.f)sp=1.f;if(sp< -1.f)sp=-1.f;
    angle[0]=atan2f(2.f*(w*x+y*z),1.f-2.f*(x*x+y*y))*deg;
    angle[1]=asinf(sp)*deg;
    angle[2]=atan2f(2.f*(w*z+x*y),1.f-2.f*(y*y+z*z))*deg;
}
static void seed_q(float roll,float pitch,float yaw){
    const float cr=cosf(roll*.5f),sr=sinf(roll*.5f),cp=cosf(pitch*.5f),sp=sinf(pitch*.5f);
    const float cy=cosf(yaw*.5f),sy=sinf(yaw*.5f);
    q[0]=cr*cp*cy+sr*sp*sy;q[1]=sr*cp*cy-cr*sp*sy;q[2]=cr*sp*cy+sr*cp*sy;q[3]=cr*cp*sy-sr*sp*cy;
    normalize_q();
}
void attitude_init(void){
    q[0]=1.f;q[1]=q[2]=q[3]=0.f;angle[0]=angle[1]=angle[2]=0;
    state=ATTITUDE_UNINITIALIZED;gravity_age_s=recover_s=0.f;
}
const float *attitude_degrees(void){return angle;}
bool attitude_ready(void){return state==ATTITUDE_VALID;}
attitude_state_t attitude_state(void){return state;}
const char *attitude_state_name(void){
    switch(state){
    case ATTITUDE_VALID:return "valid";
    case ATTITUDE_ACCEL_INVALID:return "accel-invalid";
    case ATTITUDE_GRAVITY_TIMEOUT:return "gravity-timeout";
    case ATTITUDE_RECOVERING:return "recovering";
    default:return "uninitialized";
    }
}
bool attitude_update(const float gyro[3],const float acc[3],float dt){
    /* A rejected gyro or time sample invalidates and never integrates (#103). */
    if(!gyro || !isfinite(dt) || dt<=0 || dt>0.02f){state=ATTITUDE_UNINITIALIZED;return false;}
    for(unsigned i=0;i<3;i++)if(!isfinite(gyro[i])){state=ATTITUDE_UNINITIALIZED;return false;}
    bool acc_finite=acc!=0;
    for(unsigned i=0;acc_finite && i<3;i++)if(!isfinite(acc[i]))acc_finite=false;
    const float norm=acc_finite?acc[0]*acc[0]+acc[1]*acc[1]+acc[2]*acc[2]:0.f;
    const bool gravity=acc_finite && norm>0.64f && norm<1.44f;
    if(state==ATTITUDE_UNINITIALIZED){
        if(!gravity)return false;
        /* Seed roll/pitch from gravity (valid at any pitch, including vertical);
         * keep the gyro-relative yaw reference continuous. */
        const float roll=atan2f(acc[1],acc[2]),pitch=atan2f(-acc[0],sqrtf(acc[1]*acc[1]+acc[2]*acc[2]));
        seed_q(roll,pitch,angle[2]*rad);
        state=ATTITUDE_VALID;gravity_age_s=recover_s=0.f;
    }
    float w[3]={gyro[0]*rad,gyro[1]*rad,gyro[2]*rad};
    if(gravity){
        /* Tilt error between measured and estimated body down vectors. */
        const float inv=1.f/sqrtf(norm),a0=acc[0]*inv,a1=acc[1]*inv,a2=acc[2]*inv;
        const float d0=2.f*(q[1]*q[3]-q[0]*q[2]),d1=2.f*(q[0]*q[1]+q[2]*q[3]),d2=1.f-2.f*(q[1]*q[1]+q[2]*q[2]);
        const float kp=state==ATTITUDE_VALID?kp_normal:kp_recover;
        w[0]+=kp*(a1*d2-a2*d1);w[1]+=kp*(a2*d0-a0*d2);w[2]+=kp*(a0*d1-a1*d0);
        gravity_age_s=0.f;
        if(state!=ATTITUDE_VALID){
            state=ATTITUDE_RECOVERING;recover_s+=dt;
            if(recover_s>=ATTITUDE_RECOVER_S){state=ATTITUDE_VALID;recover_s=0.f;}
        }
    }else if(!acc_finite){
        state=ATTITUDE_ACCEL_INVALID;recover_s=0.f;
    }else{
        gravity_age_s+=dt;
        if(state==ATTITUDE_VALID && gravity_age_s>ATTITUDE_GRAVITY_TIMEOUT_S){state=ATTITUDE_GRAVITY_TIMEOUT;recover_s=0.f;}
    }
    /* Exact rotation increment for this sample: q = q * dq(w*dt). */
    const float wn=sqrtf(w[0]*w[0]+w[1]*w[1]+w[2]*w[2]),half=0.5f*wn*dt;
    if(wn>1e-9f){
        const float c=cosf(half),s=sinf(half)/wn;
        const float dx=w[0]*s,dy=w[1]*s,dz=w[2]*s;
        const float qw=q[0],qx=q[1],qy=q[2],qz=q[3];
        q[0]=qw*c-qx*dx-qy*dy-qz*dz;
        q[1]=qw*dx+qx*c+qy*dz-qz*dy;
        q[2]=qw*dy-qx*dz+qy*c+qz*dx;
        q[3]=qw*dz+qx*dy-qy*dx+qz*c;
    }
    normalize_q();
    euler_from_q();
    return state==ATTITUDE_VALID;
}
void attitude_setpoint(const float sticks[4],float out[3]){
    out[0]=4.f*(sticks[0]*25.f-angle[0]);out[1]=4.f*(sticks[1]*25.f-angle[1]);out[2]=sticks[2]*200.f;
    for(unsigned i=0;i<3;i++){if(out[i]>200)out[i]=200;if(out[i]< -200)out[i]=-200;}
}
