/* SPDX-License-Identifier: Apache-2.0
 * Reuse established task mocks, but exercise the ACTUAL production capture hook.
 * No physical arming/motor assertions are inferred from these host tests. */
#define main existing_control_mode_regression
#include "host_control_mode.c"
#undef main
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
failsafe_stage_t failsafe_stage(void){return override?FAILSAFE_STAGE_HOLD:FAILSAFE_STAGE_IDLE;}
int main(void){
 CHECK(existing_control_mode_regression()==0);
 accel[0]=0;accel[1]=.5f;accel[2]=.8660254f;
 mode_range_init();CHECK(configure());fresh=true;usb=true;gyro_ok=true;healthy=true;calibrating=false;
 rc[0]=1;rc[1]=-.51f;rc[2]=.51f;gyro[0]=10;gyro[1]=-20;gyro[2]=5;
 CHECK(prime(CONTROL_MODE_ACRO));
 CHECK(bb_capture_begin(500,now));
 tick(1000);flight_log_sample_t s;CHECK(recorder_pop(&s));
 CHECK(s.armed&&s.pid_valid&&s.gyro_valid&&s.rx_fresh&&s.output_healthy);
 CHECK(s.time_us==1000&&s.dt_us==0&&s.iteration==0);
 CHECK(fabsf(s.setpoint[0]-100)<.0001f&&fabsf(s.setpoint[1]+50)<.0001f&&fabsf(s.setpoint[2]-50)<.0001f);
 CHECK(NEAR(s.p[0],.09f)&&NEAR(s.p[1],-.03f)&&NEAR(s.p[2],.045f));
 CHECK(NEAR(s.pid_output[0],captured.roll));
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==motors[i]);
 tick(1000);CHECK(!recorder_pop(&s));
 rc[3]=.01f;tick(1000);CHECK(recorder_pop(&s));
 CHECK(s.armed&&!s.pid_valid&&s.p[0]==0&&s.i[0]==0&&s.d[0]==0&&s.pid_output[0]==0&&s.dt_us==1000);
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==motors[i]);
 tick(1000);rc[4]=0;tick(1000);CHECK(recorder_pop(&s));CHECK(!s.armed&&!s.pid_valid);
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==0&&motors[i]==0);
 bb_capture_end();CHECK(!recorder_active());
 puts("PASS actual cascade capture hook: existing control regression unchanged; real rate/PID trace, post-mixer requested outputs, low-throttle reset, disarm stop, cadence and timestamps");return 0;
}
