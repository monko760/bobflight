/* SPDX-License-Identifier: Apache-2.0
 * Reuse established task mocks, but exercise the ACTUAL production capture hook.
 * No physical arming/motor assertions are inferred from these host tests. */
#define main existing_control_mode_regression
#include "host_control_mode.c"
#undef main
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
failsafe_stage_t failsafe_stage(void){return override?FAILSAFE_STAGE_HOLD:FAILSAFE_STAGE_IDLE;}
/* Schema 3 gather stubs: prove the production hook passes the context every
 * PID loop and reads the slow inputs only for samples that will be logged. */
#include "drivers/blackbox_inputs.h"
static bb_capture_ctx_t test_ctx={4,false,7,NULL,0.f,false};
static bb_capture_extra_t test_extra={{123456u,0u,99u,250000u},0x9u,0x1Du};
static unsigned fills,contexts;
void bb_inputs_fill(bb_capture_extra_t *x){fills++;*x=test_extra;}
void bb_inputs_context(bb_capture_ctx_t *c){contexts++;*c=test_ctx;c->fill=bb_inputs_fill;}
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
 CHECK(contexts==1&&fills==1);
 CHECK(s.events==0&&s.loop_code==4&&s.overruns==0&&s.telem_ok==0x9u&&s.filter_flags==0x1Du);
 CHECK(s.erpm[0]==123456u&&s.erpm[1]==0&&s.erpm[2]==99u&&s.erpm[3]==250000u);
 CHECK(fabsf(s.setpoint[0]-100)<.0001f&&fabsf(s.setpoint[1]+50)<.0001f&&fabsf(s.setpoint[2]-50)<.0001f);
 CHECK(NEAR(s.p[0],.09f)&&NEAR(s.p[1],-.03f)&&NEAR(s.p[2],.045f));
 CHECK(NEAR(s.pid_output[0],captured.roll));
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==motors[i]);
 tick(1000);CHECK(!recorder_pop(&s));
 CHECK(contexts==2&&fills==1); /* decimated loop: context only, no slow reads */
 rc[3]=.01f;tick(1000);CHECK(recorder_pop(&s));
 CHECK(s.armed&&!s.pid_valid&&s.p[0]==0&&s.i[0]==0&&s.d[0]==0&&s.pid_output[0]==0&&s.dt_us==1000);
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==motors[i]);
 tick(1000);rc[4]=0;tick(1000);CHECK(recorder_pop(&s));CHECK(!s.armed&&!s.pid_valid);
 CHECK(s.events&BB_EVENT_DISARM);CHECK(!(s.events&BB_EVENT_ARM));
 for(unsigned i=0;i<4;i++)CHECK(s.motor[i]==0&&motors[i]==0);
 bb_capture_end();CHECK(!recorder_active());
 /* Session 2: transitions on decimated loops reach the next logged frame. */
 test_ctx.loop_code=4;test_ctx.overruns_total=100;test_ctx.telem_capture_failed=false;
 CHECK(prime(CONTROL_MODE_ACRO));CHECK(bb_capture_begin(500,now));fills=0;
 tick(1000);CHECK(recorder_pop(&s));CHECK(s.events==0&&s.overruns==0&&s.loop_code==4&&fills==1);
 test_ctx.loop_code=8;test_ctx.overruns_total=103;test_ctx.telem_capture_failed=true;override=true;
 tick(1000);CHECK(!recorder_pop(&s));CHECK(fills==1);
 CHECK(bb_capture_pending_events()&BB_EVENT_LOOP_RATE);
 override=false;tick(1000);CHECK(recorder_pop(&s));
 CHECK(s.events&BB_EVENT_LOOP_RATE);CHECK(s.events&BB_EVENT_FAILSAFE_STAGE);CHECK(s.events&BB_EVENT_TELEM_CAPTURE_FAIL);
 CHECK(s.loop_code==8&&s.overruns==3&&bb_capture_pending_events()==0);
 tick(1000);tick(1000);CHECK(recorder_pop(&s));CHECK(s.events==0); /* cleared once written */
 fresh=false;tick(1000);fresh=true;tick(1000);CHECK(recorder_pop(&s));CHECK(s.events&BB_EVENT_RX_LOST);
 bb_capture_end();CHECK(!recorder_active());
 /* Same production task: override zero must not be replaced by pilot .8. */
 CHECK(prime(CONTROL_MODE_ACRO));rc[3]=.8f;CHECK(bb_capture_begin(1000,now));
 tick(1000);CHECK(recorder_pop(&s));CHECK(NEAR(s.setpoint_throttle,.8f)&&NEAR(s.rc[3],.8f));
 override=true;fresh=false;tick(1000);CHECK(recorder_pop(&s));
 CHECK(s.setpoint_throttle==0.f&&NEAR(s.rc[3],.8f)&&!s.rx_fresh);bb_capture_end();override=false;fresh=true;
 puts("PASS actual cascade capture hook: existing control regression unchanged; real rate/PID trace, post-mixer requested outputs, low-throttle reset, disarm stop, cadence and timestamps; schema 3 context every loop, slow inputs only when logged, events latched across decimated loops and cleared when written");return 0;
}
