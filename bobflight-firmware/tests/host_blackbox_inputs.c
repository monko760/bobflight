/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Schema 3 Blackbox gather (drivers/blackbox_inputs.c) against the REAL RPM
 * filter glue, with DShot telemetry, notch and scheduler state stubbed. Proves
 * the logger getter is read-only: a snapshot never refreshes the filter. */
#include "drivers/blackbox_inputs.h"
#include "drivers/dshot_telem.h"
#include "drivers/gyro.h"
#include "drivers/rpm_filter_gyro.h"
#include "flight/config.h"
#include "sched/scheduler.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static bool bidir,capture_failed,notch[2];
static dshot_telem_status_t status[4];
static uint32_t erpm[4],loop_hz=4000u;
static scheduler_stats_t stats;
bool dshot_bidir_enabled(void){return bidir;}
uint32_t dshot_erpm(unsigned m){return m<4u&&status[m]==DSHOT_TELEM_OK?erpm[m]:0u;}
dshot_telem_status_t dshot_telem_status(unsigned m){return m<4u?status[m]:DSHOT_TELEM_NONE;}
bool dshot_telem_capture_failed(void){return capture_failed;}
bool gyro_notch_active_snapshot(unsigned idx){return idx>=1u&&idx<=2u&&notch[idx-1u];}
void gyro_set_post_filter(gyro_post_filter_fn fn){(void)fn;}
const scheduler_stats_t *scheduler_stats(void){return &stats;}
uint32_t scheduler_loop_target_hz(void){return loop_hz;}
static void same_status(const rpm_filter_status_t *a,const rpm_filter_status_t *b){assert(!memcmp(a,b,sizeof *a));}
int main(void){
 config_init();
 /* Before the filter ever ran: off, nothing tracked, no telemetry. */
 rpm_filter_status_t st;rpm_filter_gyro_snapshot(&st);assert(st.reason==RPM_FILTER_OFF&&st.harmonics_active==0);
 bb_capture_extra_t x;memset(&x,0xA5,sizeof x);bb_inputs_fill(&x);
 assert(x.telem_ok==0&&x.erpm[0]==0&&x.erpm[3]==0&&x.filter_flags==0);
 /* Live: bidir on, motors 1 and 3 OK (motor 3 OK with eRPM 0), 2 timed out, 4 bad CRC. */
 assert(config_set_key("rpm_filter_harmonics",3));
 bidir=true;status[0]=DSHOT_TELEM_OK;erpm[0]=123456u;status[1]=DSHOT_TELEM_TIMEOUT;erpm[1]=777u;
 status[2]=DSHOT_TELEM_OK;erpm[2]=0u;status[3]=DSHOT_TELEM_CRC_FAIL;erpm[3]=5000u;notch[0]=true;
 rpm_filter_gyro_install();float v[3]={1,2,3};for(unsigned i=0;i<8;i++)rpm_filter_gyro_process(v,1.f/4000.f);
 rpm_filter_gyro_snapshot(&st);assert(st.reason==RPM_FILTER_OK&&st.harmonics_active==3u);
 bb_inputs_fill(&x);
 assert(x.telem_ok==0x5u&&x.erpm[0]==123456u&&x.erpm[1]==0u&&x.erpm[2]==0u&&x.erpm[3]==0u);
 assert(x.filter_flags==(BB_FILTER_NOTCH1_ACTIVE|BB_FILTER_RPM_ACTIVE|(3u<<BB_FILTER_RPM_REASON_SHIFT)|(3u<<BB_FILTER_RPM_HARM_SHIFT)));
 assert(x.filter_flags==125u);
 /* Read-only: telemetry and settings change, yet snapshots (and the fill) keep
  * reporting the state the gyro path last applied until the filter refreshes. */
 rpm_filter_status_t before=st;
 for(unsigned m=0;m<4;m++){status[m]=DSHOT_TELEM_NONE;}
 bidir=false;assert(config_set_key("rpm_filter_harmonics",1));
 for(unsigned i=0;i<100;i++){rpm_filter_gyro_snapshot(&st);same_status(&st,&before);}
 bb_inputs_fill(&x);assert(x.telem_ok==0&&x.erpm[0]==0&&x.filter_flags==125u);
 rpm_filter_gyro_status(&st,1.f/4000.f);assert(st.reason==RPM_FILTER_BIDIR_OFF); /* refresh does recompute */
 rpm_filter_gyro_snapshot(&st);assert(st.reason==RPM_FILTER_BIDIR_OFF&&st.motor_valid[0]==false);
 notch[0]=false;notch[1]=true;bb_inputs_fill(&x);
 assert(x.filter_flags==(BB_FILTER_NOTCH2_ACTIVE|(1u<<BB_FILTER_RPM_REASON_SHIFT))); /* inactive: no harmonics */
 /* Per-loop context. */
 bb_capture_ctx_t c;memset(&c,0,sizeof c);stats.overruns=42u;capture_failed=true;
 const uint32_t loops[]={1000u,2000u,4000u,8000u},codes[]={4u,8u,16u,32u};
 for(unsigned i=0;i<4;i++){loop_hz=loops[i];bb_inputs_context(&c);assert(c.loop_code==codes[i]&&c.overruns_total==42u&&c.telem_capture_failed&&c.fill==bb_inputs_fill);}
 assert(bb_loop_code(0)==0&&bb_loop_code(249)==0&&bb_loop_code(12000)==BB_LOOP_CODE_MAX);
 assert(bb_filter_flags_pack(false,false,2u,3u)==(2u<<BB_FILTER_RPM_REASON_SHIFT));
 assert(bb_filter_flags_pack(true,true,3u,9u)==127u);
 bb_inputs_fill(NULL);bb_inputs_context(NULL);rpm_filter_gyro_snapshot(NULL);
 puts("PASS blackbox schema 3 inputs: telemetry mask/eRPM gated on OK, filter flag bit order, loop code, overruns; RPM snapshot is read-only (no refresh until the filter runs)");
 return 0;
}
