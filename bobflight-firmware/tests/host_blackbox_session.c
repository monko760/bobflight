/* SPDX-License-Identifier: Apache-2.0
 * Session/capture/encoder integration with a deliberately delayed fake FAT sink.
 * Real FAT32 storage is tested separately against sector fixtures. */
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t bytes[400000],expected[400000],pending[512];
static size_t length,expected_len;static unsigned delay,pending_used;static bool sink_fail;
static uint64_t now;
static bb_session_t session;
bool fatlog_start(fatlog_t *f,const fatlog_io_t *io,uint64_t t){(void)t;memset(f,0,sizeof *f);f->io=*io;f->phase=FATLOG_PREPARING;strcpy(f->filename,"BFL00001.BBL");delay=2;length=0;return true;}
int fatlog_poll(fatlog_t *f,uint64_t t){(void)t;
 if(sink_fail){f->phase=FATLOG_ERROR;f->error="injected-card-failure";return f->phase;}
 if(delay){delay--;return f->phase;}
 if(f->phase==FATLOG_WRITING){assert(length+pending_used<=sizeof bytes);memcpy(bytes+length,pending,pending_used);length+=pending_used;f->bytes_written=length;pending_used=0;f->phase=FATLOG_READY;}
 if(f->phase==FATLOG_PREPARING)f->phase=FATLOG_READY;
 if(f->phase==FATLOG_CLOSING)f->phase=FATLOG_DONE;
 return f->phase;
}
bool fatlog_write(fatlog_t *f,const uint8_t s[512],uint16_t used,uint64_t t){(void)t;assert(f->phase==FATLOG_READY&&used&&used<=512);memcpy(pending,s,512);pending_used=used;delay=2;f->phase=FATLOG_WRITING;return true;}
bool fatlog_close(fatlog_t *f,uint64_t t){(void)t;assert(f->phase==FATLOG_READY);f->phase=FATLOG_CLOSING;delay=2;return true;}
static void poll_n(unsigned count){for(unsigned i=0;i<count;i++)bb_session_poll(&session,now);}
static void finish(void){for(unsigned i=0;i<10000&&bb_session_busy(&session);i++)bb_session_poll(&session,now);assert(session.phase==BBS_DONE);assert(length==session.file.bytes_written);}
int main(int argc,char **argv){
 config_init();pid_init();fatlog_io_t io={0};blackbox_metadata_t m={500,1000,300,"0.2.0-session-test",config_get()};
 assert(bb_session_start(&session,&io,&m,now));assert(!bb_session_start(&session,&io,&m,now));poll_n(200);assert(session.phase==BBS_RECORDING);
 expected_len=blackbox_header((char*)expected,sizeof expected,&m);assert(expected_len);
 float raw[3]={26,-13,4},gyro[3]={25,-12.5f,4},setpoint[3]={35,-10,5},motor[4]={.2f,.4f,.6f,.8f},rc[4]={.1f,-.05f,.02f,.25f};pid_axis_out_t out;
 for(unsigned j=0;j<1200;j++){
  now+=1000;pid_set_dt(.001f);pid_update(gyro,setpoint,&out);
  if(j%2==0){
   pid_trace_t trace;assert(pid_trace_read(&trace));flight_log_sample_t s={.iteration=j,.time_us=(uint32_t)now,.dt_us=j?1000:0,.armed=1,.mode=1,.pid_valid=1,.gyro_valid=1,.rx_fresh=1,.output_healthy=1};
   memcpy(s.gyro_raw,raw,sizeof raw);memcpy(s.gyro,gyro,sizeof gyro);memcpy(s.setpoint,setpoint,sizeof setpoint);memcpy(s.motor,motor,sizeof motor);memcpy(s.rc,rc,sizeof rc);memcpy(s.p,trace.p,sizeof s.p);memcpy(s.i,trace.i,sizeof s.i);memcpy(s.d,trace.d,sizeof s.d);s.pid_output[0]=out.roll;s.pid_output[1]=out.pitch;s.pid_output[2]=out.yaw;
   size_t n=blackbox_frame(expected+expected_len,sizeof expected-expected_len,&s);assert(n);expected_len+=n;
  }
  bb_capture_observe(now,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);poll_n(40);
 }
 bb_session_stop(&session);finish();expected_len+=blackbox_end(expected+expected_len,sizeof expected-expected_len);
 assert(session.frames==600&&recorder_stats()->total_dropped==0);assert(length==expected_len&&!memcmp(bytes,expected,length));
 if(argc>1){FILE *f=fopen(argv[1],"wb");assert(f);assert(fwrite(bytes,1,length,f)==length);assert(fclose(f)==0);}
 printf("PASS session output byte-for-byte: 600 actual PID captures, %zu bytes, header + complete frames + EOF, delayed writes and exact final length\n",length);
 /* Auto finish after an observed armed-to-disarmed transition, without motor writes. */
 assert(bb_session_start(&session,&io,&m,now));poll_n(200);now+=1000;bb_capture_observe(now,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);poll_n(40);
 now+=2000;pid_init();out=(pid_axis_out_t){0};bb_capture_observe(now,raw,gyro,setpoint,&out,motor,rc,false,1,0,true,true,true);finish();assert(!strcmp(session.reason,"disarmed"));
 /* Stop while preparing still yields a closed header/end-marker file. */
 assert(bb_session_start(&session,&io,&m,now));bb_session_stop(&session);finish();assert(session.frames==0&&!recorder_active());
 assert(bb_session_start(&session,&io,&m,now));poll_n(200);sink_fail=true;poll_n(1);assert(session.phase==BBS_ERROR&&!recorder_active());assert(!strcmp(session.reason,"injected-card-failure"));sink_fail=false;
 assert(bb_session_start(&session,&io,&m,now));poll_n(200);now+=600000001;finish();assert(!strcmp(session.reason,"session-limit"));
 puts("PASS session lifecycle: duplicate start refused; manual/disarm/time-limit stop; prepare cancellation; failure stops capture; no hang");
}
