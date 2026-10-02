/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Foreground producer/drain. Each call encodes up to a bounded number of queued
 * samples into an encoded-byte RAM ring, advances one FAT step and submits at
 * most one 512-byte sector. Encoding continues while a sector is in flight, so
 * card write stalls are absorbed by the ring instead of the 64-sample FIFO.
 * Never waits for a card, changes flight state, or fabricates samples. */
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include <string.h>
#if defined(BOBFLIGHT_MCU) && defined(__arm__)
#define BB_RING_SECTION __attribute__((section(".dma"),aligned(32)))
#else
#define BB_RING_SECTION
#endif
/* One recorder/session exists at a time; contents need no initialization. */
static uint8_t ring[BB_SESSION_RING_BYTES] BB_RING_SECTION;
static void fail(bb_session_t *s,const char *reason){bb_capture_end();s->phase=BBS_ERROR;s->reason=reason;}
bool bb_session_busy(const bb_session_t *s){return s&&s->phase>=BBS_PREPARING&&s->phase<=BBS_CLOSING;}
const char *bb_session_name(const bb_session_t *s){
 static const char *names[]={"idle","preparing","writing-header","recording","draining","closing","done","error"};
 return s&&s->phase<=BBS_ERROR?names[s->phase]:"error";
}
uint32_t bb_session_queue_full_drops(void){
 const flight_recorder_stats_t *st=recorder_stats();uint64_t other=(uint64_t)st->total_invalid+st->total_regressed;
 return st->total_dropped>other?st->total_dropped-(uint32_t)other:0u;
}
static size_t ring_free(const bb_session_t *s){return BB_SESSION_RING_BYTES-s->ring_count;}
static void ring_put(bb_session_t *s,const uint8_t *src,size_t n){
 size_t first=BB_SESSION_RING_BYTES-s->ring_head;if(first>n)first=n;
 memcpy(ring+s->ring_head,src,first);memcpy(ring,src+first,n-first);
 s->ring_head=(s->ring_head+n)%BB_SESSION_RING_BYTES;s->ring_count+=n;if(s->ring_count>s->ring_peak)s->ring_peak=s->ring_count;
}
static void ring_get(bb_session_t *s,uint8_t *dst,size_t n){
 size_t first=BB_SESSION_RING_BYTES-s->ring_tail;if(first>n)first=n;
 memcpy(dst,ring+s->ring_tail,first);memcpy(dst+first,ring,n-first);
 s->ring_tail=(s->ring_tail+n)%BB_SESSION_RING_BYTES;s->ring_count-=n;
}
static uint32_t tail_hash(const char *h,size_t len){
 uint32_t v=2166136261u;for(size_t i=FATLOG_SECTOR_SIZE;i<len;i++){v^=(uint8_t)h[i];v*=16777619u;}return v;
}
bool bb_session_start(bb_session_t *s,const fatlog_io_t *io,const blackbox_metadata_t *m,uint64_t now){
 if(!s||!io||!m||bb_session_busy(s)||recorder_active())return false;
 recorder_reset();memset(s,0,sizeof *s);s->reason="preparing";s->started_us=now;
 s->meta=*m;if(!s->meta.requested_hz)s->meta.requested_hz=m->sample_hz;if(!s->meta.rate_reason)s->meta.rate_reason=BB_RATE_REASON_DEFAULT;
 s->sample_hz=s->header_hz=m->sample_hz;s->requested_hz=s->meta.requested_hz;s->rate_reason=s->meta.rate_reason;
 s->header_len=blackbox_header(s->header,sizeof s->header,&s->meta);
 if(!s->header_len||s->header_len>BB_SESSION_RING_BYTES){fail(s,"invalid-log-metadata");return false;}
 s->header_tail_hash=tail_hash(s->header,s->header_len);
 ring_put(s,(const uint8_t *)s->header,s->header_len);
 if(!fatlog_start(&s->file,io,now)){fail(s,"filesystem-start-refused");return false;}
 s->phase=BBS_PREPARING;return true;
}
void bb_session_stop(bb_session_t *s){
 if(!bb_session_busy(s))return;
 s->stop_requested=true;s->reason="user-stop";bb_capture_end();
}
/* Deterministic, host-testable auto-rate. Only queue-full losses count: those
 * are the card/writer failing to keep up, not invalid sensor samples. */
static void rate_policy(bb_session_t *s,uint64_t now){
 if(now-s->window_start_us<BB_RATE_WINDOW_US)return;
 const flight_recorder_stats_t *st=recorder_stats();uint32_t lost=bb_session_queue_full_drops();
 /* Due slots only: decimated calls (total_skipped) are not logging attempts. */
 uint32_t due=st->total_attempted-st->total_skipped;
 uint32_t lost_w=lost-s->window_lost0,attempted_w=due-s->window_attempted0;
 s->window_start_us=now;s->window_lost0=lost;s->window_attempted0=due;
 /* One settle window after a halving: the backlog built at the old rate is
  * still draining, so its tail losses must not trigger a second halving. */
 if(s->settle_windows){s->settle_windows--;return;}
 if(!lost_w||(uint64_t)lost_w*1000u<=(uint64_t)attempted_w*BB_RATE_DROP_PERMILLE||s->sample_hz<=BB_RATE_FLOOR_HZ)return;
 uint32_t hz=s->sample_hz/2u;if(hz<BB_RATE_FLOOR_HZ)hz=BB_RATE_FLOOR_HZ;
 if(recorder_lower_rate(hz)){s->sample_hz=hz;s->rate_reason=BB_RATE_REASON_CARD_SLOW;s->rate_lowerings++;s->settle_windows=BB_RATE_SETTLE_WINDOWS;}
}
static void drain(bb_session_t *s){
 if(s->phase!=BBS_RECORDING&&s->phase!=BBS_DRAINING)return;
 flight_log_sample_t sample;
 for(unsigned n=0;n<BB_SESSION_FRAMES_PER_POLL&&ring_free(s)>=sizeof s->packet;n++){
  if(!recorder_pop(&sample))return;
  size_t len=blackbox_frame(s->packet,sizeof s->packet,&sample);
  if(!len){fail(s,"sample-encoding-failed");return;}
  ring_put(s,s->packet,len);s->frames++;
  if(sample.armed)s->seen_armed=true;
  else if(s->seen_armed&&!s->stop_requested){s->stop_requested=true;s->reason="disarmed";bb_capture_end();}
 }
}
/* If the rate was lowered mid-session, rewrite the file's first sector so the
 * header states the effective rate. The rate block has fixed length and lives
 * in sector 0; everything after sector 0 must re-encode identically. */
static bool header_patch(bb_session_t *s,uint64_t now){
 if(s->patch_done||s->sample_hz==s->header_hz)return false;
 s->patch_done=true;
 blackbox_metadata_t m=s->meta;m.sample_hz=s->sample_hz;m.rate_reason=s->rate_reason;
 size_t len=blackbox_header(s->header,sizeof s->header,&m);
 /* Defensive: never patch unless only sector 0 differs; the file then still
  * closes normally and status keeps reporting the true effective rate. */
 if(len!=s->header_len||len<FATLOG_SECTOR_SIZE||tail_hash(s->header,len)!=s->header_tail_hash)return false;
 memcpy(s->sector,s->header,FATLOG_SECTOR_SIZE);
 if(!fatlog_rewrite_first_sector(&s->file,s->sector,now))return false;
 s->header_hz=s->sample_hz;return true;
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
 if(s->phase==BBS_RECORDING&&!s->stop_requested)rate_policy(s,now);
 drain(s);if(s->phase==BBS_ERROR)return;
 if(s->file.phase!=FATLOG_READY)return;
 if(s->phase==BBS_PREPARING)s->phase=BBS_HEADER;
 if(s->phase==BBS_HEADER){
  /* The header is already queued ahead of any frame in the ring. */
  if(s->stop_requested)s->phase=BBS_DRAINING;
  else if(bb_capture_begin(s->sample_hz,now)){s->phase=BBS_RECORDING;s->reason="recording";s->window_start_us=now;}
  else {fail(s,"capture-start-refused");return;}
 }
 if(s->stop_requested&&s->phase==BBS_RECORDING)s->phase=BBS_DRAINING;
 if(s->phase==BBS_DRAINING&&!s->end_created&&!recorder_stats()->queue_depth){
  size_t n=blackbox_end(s->packet,sizeof s->packet);
  if(!n){fail(s,"end-marker-failed");return;}
  if(ring_free(s)>=n){ring_put(s,s->packet,n);s->end_created=true;}
 }
 if(s->ring_count>=FATLOG_SECTOR_SIZE){
  ring_get(s,s->sector,FATLOG_SECTOR_SIZE);
  if(!fatlog_write(&s->file,s->sector,FATLOG_SECTOR_SIZE,now))fail(s,"sector-write-refused");
  return;
 }
 if(!s->end_created)return;
 if(s->ring_count){
  size_t used=s->ring_count;ring_get(s,s->sector,used);memset(s->sector+used,0,FATLOG_SECTOR_SIZE-used);
  if(!fatlog_write(&s->file,s->sector,(uint16_t)used,now))fail(s,"final-sector-refused");
  return;
 }
 if(header_patch(s,now))return;
 if(!fatlog_close(&s->file,now)){fail(s,"close-refused");return;}
 s->phase=BBS_CLOSING;
}
