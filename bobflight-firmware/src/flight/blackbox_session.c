/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Foreground producer/drain. One FAT step, one frame or one bounded buffer copy
 * per call. Never waits for a card, changes flight state, or fabricates samples. */
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include <string.h>
static void fail(bb_session_t *s,const char *reason){bb_capture_end();s->phase=BBS_ERROR;s->reason=reason;}
bool bb_session_busy(const bb_session_t *s){return s&&s->phase>=BBS_PREPARING&&s->phase<=BBS_CLOSING;}
const char *bb_session_name(const bb_session_t *s){
 static const char *names[]={"idle","preparing","writing-header","recording","draining","closing","done","error"};
 return s&&s->phase<=BBS_ERROR?names[s->phase]:"error";
}
bool bb_session_start(bb_session_t *s,const fatlog_io_t *io,const blackbox_metadata_t *m,uint64_t now){
 if(!s||!io||!m||bb_session_busy(s)||recorder_active())return false;
 recorder_reset();memset(s,0,sizeof *s);s->reason="preparing";s->sample_hz=m->sample_hz;s->started_us=now;
 s->header_len=blackbox_header(s->header,sizeof s->header,m);
 if(!s->header_len){fail(s,"invalid-log-metadata");return false;}
 if(!fatlog_start(&s->file,io,now)){fail(s,"filesystem-start-refused");return false;}
 s->phase=BBS_PREPARING;return true;
}
void bb_session_stop(bb_session_t *s){
 if(!bb_session_busy(s))return;
 s->stop_requested=true;s->reason="user-stop";bb_capture_end();
}
void bb_session_poll(bb_session_t *s,uint64_t now){
 if(!bb_session_busy(s))return;
 if(now<s->started_us){fail(s,"clock-regressed");return;}
 if((s->phase==BBS_PREPARING||s->phase==BBS_HEADER)&&now-s->started_us>120000000u){fail(s,"prepare-timeout");return;}
 if(s->phase==BBS_RECORDING&&!s->stop_requested&&(!recorder_active()||now-s->started_us>=600000000u||s->file.bytes_written>=32u*1024u*1024u)){
  s->stop_requested=true;s->reason=recorder_active()?"session-limit":"capture-stopped";bb_capture_end();
 }
 fatlog_poll(&s->file,now);
 if(s->file.phase==FATLOG_ERROR){fail(s,s->file.error?s->file.error:"filesystem-io-error");return;}
 if(s->phase==BBS_CLOSING){if(s->file.phase==FATLOG_DONE)s->phase=BBS_DONE;return;}
 if(s->file.phase!=FATLOG_READY)return;
 if(s->used==512){
  if(!fatlog_write(&s->file,s->sector,512,now)){fail(s,"sector-write-refused");return;}
  s->used=0;return;
 }
 if(s->phase==BBS_PREPARING)s->phase=BBS_HEADER;
 if(s->phase==BBS_HEADER){
  size_t n=s->header_len-s->header_pos;if(n>512-s->used)n=512-s->used;
  if(n){memcpy(s->sector+s->used,s->header+s->header_pos,n);s->used+=n;s->header_pos+=n;return;}
  if(s->stop_requested)s->phase=BBS_DRAINING;
  else if(bb_capture_begin(s->sample_hz,now)){s->phase=BBS_RECORDING;s->reason="recording";}
  else fail(s,"capture-start-refused");
  return;
 }
 if(s->stop_requested&&s->phase==BBS_RECORDING)s->phase=BBS_DRAINING;
 if(s->packet_pos<s->packet_len){
  size_t n=s->packet_len-s->packet_pos;if(n>512-s->used)n=512-s->used;
  memcpy(s->sector+s->used,s->packet+s->packet_pos,n);s->used+=n;s->packet_pos+=n;return;
 }
 if(s->end_created){
  if(s->used){memset(s->sector+s->used,0,512-s->used);if(!fatlog_write(&s->file,s->sector,(uint16_t)s->used,now)){fail(s,"final-sector-refused");return;}s->used=0;return;}
  if(!fatlog_close(&s->file,now)){fail(s,"close-refused");return;}
  s->phase=BBS_CLOSING;return;
 }
 flight_log_sample_t sample;
 if(recorder_pop(&sample)){
  s->packet_len=blackbox_frame(s->packet,sizeof s->packet,&sample);s->packet_pos=0;
  if(!s->packet_len){fail(s,"sample-encoding-failed");return;}
  s->frames++;
  if(sample.armed)s->seen_armed=true;
  else if(s->seen_armed&&!s->stop_requested){s->stop_requested=true;s->reason="disarmed";bb_capture_end();}
  return;
 }
 if(s->phase==BBS_DRAINING){s->packet_len=blackbox_end(s->packet,sizeof s->packet);s->packet_pos=0;s->end_created=true;}
}
