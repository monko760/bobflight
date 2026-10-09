/* SPDX-License-Identifier: Apache-2.0
 * Independently round-trip absolute/delta values, including integer extremes.
 * No I/O, hardware, third-party implementation or relaxed throughput limits. */
#include "flight/blackbox_encode.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
static uint32_t take(const uint8_t *b,size_t n,size_t *p){uint32_t v=0;unsigned shift=0;for(unsigned k=0;k<5;k++){assert(*p<n);uint8_t c=b[(*p)++];v|=(uint32_t)(c&127u)<<shift;if(!(c&128u))return v;shift+=7;}assert(0);return 0;}
int main(void){
 config_init();blackbox_metadata_t m={500,1000,300,"delta-test",config_get(),0,NULL,NULL,1000,1,true};char h[BLACKBOX_HEADER_MAX_BYTES];assert(blackbox_header(h,sizeof h,&m));
 assert(strstr(h,"H I interval:64\nH P interval:1/2\n"));
 const char *line=strstr(h,"H Field I signed:")+strlen("H Field I signed:");bool sign[BLACKBOX_FIELD_COUNT];
 for(unsigned i=0;i<BLACKBOX_FIELD_COUNT;i++){assert(line[0]=='0'||line[0]=='1');sign[i]=*line=='1';line+=2;}
 blackbox_encoder_state_t st={0};int64_t previous[BLACKBOX_FIELD_COUNT]={0};unsigned keys=0,preds=0,last_key=0;
 for(unsigned j=0;j<400;j++){
  flight_log_sample_t s={0};s.iteration=j*2;s.time_us=j*2000;s.dt_us=1000;s.overruns=(j==137u||j==271u)?UINT32_MAX:j;
  s.rc[3]=(j%101)/100.f;s.setpoint_throttle=s.rc[3];s.armed=1;s.gyro_valid=s.pid_valid=s.rx_fresh=s.output_healthy=1;
  for(unsigned a=0;a<3;a++){s.gyro[a]=(float)((int)(j%73)-36);s.gyro_raw[a]=s.gyro[a]+.1f;s.setpoint[a]=s.gyro[a]*2;s.p[a]=((int)(j%21)-10)*.01f;s.rc[a]=((int)(j%201)-100)/100.f;}
  s.accel_valid=s.attitude_valid=true;s.accel_g[2]=1;s.attitude_deg[0]=(float)(j%90);
  uint8_t absolute[BLACKBOX_FRAME_MAX_BYTES],stream[BLACKBOX_FRAME_MAX_BYTES];size_t a=blackbox_frame(absolute,sizeof absolute,&s);assert(a);
  blackbox_encoder_state_t saved=st;memset(stream,0xA5,sizeof stream);
  assert(!blackbox_stream_frame(stream,0,&s,&st));assert(!memcmp(&saved,&st,sizeof st));for(unsigned k=0;k<sizeof stream;k++)assert(stream[k]==0xA5);
  flight_log_sample_t bad=s;bad.gyro[0]=NAN;assert(!blackbox_stream_frame(stream,sizeof stream,&bad,&st));assert(!memcmp(&saved,&st,sizeof st));
  size_t b=blackbox_stream_frame(stream,sizeof stream,&s,&st);assert(b);bool key=stream[0]=='I';assert(key||stream[0]=='P');if(key){keys++;last_key=j;}else{preds++;assert(j-last_key<BLACKBOX_KEYFRAME_INTERVAL);}
  if(j==0||j==137||j==138||j==271||j==272)assert(key); /* no signed overflow or unsigned wrap approximation */
  size_t ap=1,bp=1;for(unsigned i=0;i<BLACKBOX_FIELD_COUNT;i++){
   uint32_t av=take(absolute,a,&ap),bv=take(stream,b,&bp);int64_t want=sign[i]?((int64_t)(av>>1)^-(int64_t)(av&1)):(int64_t)av;
   int64_t got=(!key||sign[i])?((int64_t)(bv>>1)^-(int64_t)(bv&1)):(int64_t)bv;if(!key)got+=previous[i];assert(want==got);previous[i]=got;
  }assert(ap==a&&bp==b);
 }
 assert(keys>=13&&preds>300);puts("PASS delta codec: every field exact, 32-record anchors, uint32 extremes, failed encodes preserve output/state");
}
