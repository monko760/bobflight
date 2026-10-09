/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_encode.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <float.h>
int main(int argc,char **argv){ config_init();blackbox_metadata_t meta={500,1000,300,"0.2.0-encoder-fixture",config_get(),0,NULL,"kakute_f7_hdv",8000,8};
 char header[BLACKBOX_HEADER_MAX_BYTES];size_t h=blackbox_header(header,sizeof header,&meta);assert(h&&h<sizeof header);assert(strstr(header,"H Firmware revision:BobFlight 0.2.0-encoder-fixture"));assert(strstr(header,"H I interval:2\nH P interval:1/2\n"));assert(strstr(header,"H looptime:1000\n"));assert(strstr(header,"H BobFlight pid_roll_p:"));assert(strstr(header,"H BobFlight pid_yaw_d:"));
 assert(strstr(header,"H BobFlight log_rate_hz:500 requested_hz:500 reason:default "));
 /* Fixed-length rate block in sector 0 for every supported rate/reason/loop, so
  * an effective-rate change can be patched in place without moving bytes. */
 {const uint32_t loops[]={1000,4000,8000},rates[]={1000,500,250,125};const char *reasons[]={"default","auto-lowered-card-slow"};
  for(unsigned l=0;l<3;l++){size_t base=0;
   for(unsigned r=0;r<4;r++)for(unsigned k=0;k<2;k++){
    if(loops[l]%rates[r])continue;
    blackbox_metadata_t m2=meta;m2.loop_hz=loops[l];m2.sample_hz=rates[r];m2.requested_hz=1000;m2.rate_reason=reasons[k];
    char h2[BLACKBOX_HEADER_MAX_BYTES];size_t n2=blackbox_header(h2,sizeof h2,&m2);assert(n2);if(!base)base=n2;assert(n2==base);
    const char *line=strstr(h2,"H BobFlight log_rate_hz:");assert(line);const char *eol=strchr(line,'\n');assert(eol&&eol-h2<512);
    const char *iv=strstr(h2,"H I interval:");assert(iv&&line-iv<(long)BLACKBOX_RATE_BLOCK_BYTES);
   }}
  blackbox_metadata_t m3=meta;m3.sample_hz=125;char h3[BLACKBOX_HEADER_MAX_BYTES];assert(blackbox_header(h3,sizeof h3,&m3)&&strstr(h3,"H I interval:8\nH P interval:1/8\n"));
  m3.requested_hz=250;m3.sample_hz=500;assert(!blackbox_header(h3,sizeof h3,&m3)); /* effective never above requested */
  m3.requested_hz=500;m3.rate_reason="Bad Reason";assert(!blackbox_header(h3,sizeof h3,&m3));
  m3.rate_reason="auto-lowered-card-slow-and-way-too-long";assert(!blackbox_header(h3,sizeof h3,&m3));}
 char small[16];memset(small,0x5a,sizeof small);assert(!blackbox_header(small,sizeof small,&meta));for(unsigned n=0;n<sizeof small;n++)assert(small[n]==0x5a);
 meta.revision="bad\nH Firmware revision:Betaflight 4.5.0";assert(!blackbox_header(header,sizeof header,&meta));meta.revision="Betaflight 4.5.0";assert(!blackbox_header(header,sizeof header,&meta));meta.revision="0.2.0-encoder-fixture";meta.dshot_kbps=600;assert(blackbox_header(header,sizeof header,&meta));assert(strstr(header,"H motor_pwm_protocol:7\n"));meta.dshot_kbps=300;
 uint8_t out[BLACKBOX_FRAME_MAX_BYTES],sentinel[BLACKBOX_FRAME_MAX_BYTES];memset(out,0x5a,sizeof out);memcpy(sentinel,out,sizeof out);
 flight_log_sample_t sample={.dt_us=1000,.gyro={25,-12.5f,4},.gyro_raw={26,-13,4},.setpoint={35,-10,5},.setpoint_throttle=.25f,.p={.1f,-.02f,.005f},.i={-.01f,.004f,0},.d={.005f,-.002f,0},.pid_output={.095f,-.018f,.005f},.motor={.2f,.4f,.6f,.8f},.rc={.1f,-.05f,.02f,.25f},.armed=1,.mode=1};

 {flight_log_sample_t t=sample;t.rc[3]=.8f;t.setpoint_throttle=.3f;
  uint8_t b[BLACKBOX_FRAME_MAX_BYTES];size_t z=blackbox_frame(b,sizeof b,&t);assert(z);size_t pos=1;
  for(unsigned f=0;f<BLACKBOX_FIELD_COUNT;f++){uint32_t u=0;unsigned shift=0;uint8_t c;do{assert(pos<z);c=b[pos++];u|=(uint32_t)(c&127u)<<shift;shift+=7;}while(c&128u);
   if(f==11u)assert((u>>1)==300u);if(f==31u)assert((u>>1)==1800u);}
  const float bad[]={NAN,INFINITY,-.001f,1.001f};for(unsigned i=0;i<4;i++){t.setpoint_throttle=bad[i];memset(b,0x5a,sizeof b);assert(!blackbox_frame(b,sizeof b,&t));for(unsigned j=0;j<sizeof b;j++)assert(b[j]==0x5a);}}
#if BLACKBOX_HAS_BAROMETER
 {flight_log_sample_t t=sample;t.baro_valid=t.baro_alt_valid=1;t.baro_pressure_pa=100653.25f;t.baro_temp_c=25.0825f;t.baro_alt_cm=-123.4f;t.baro_reference_pa=101000.f;t.baro_sample=32;t.baro_age_ms=5;
  uint8_t b[BLACKBOX_FRAME_MAX_BYTES];size_t z=blackbox_frame(b,sizeof b,&t),pos=1;assert(z);
  for(unsigned f=0;f<BLACKBOX_FIELD_COUNT;f++){uint32_t u=0;unsigned sh=0;uint8_t c;do{assert(pos<z);c=b[pos++];u|=(uint32_t)(c&127u)<<sh;sh+=7;}while(c&128u);
   if(f==62)assert(((int32_t)(u>>1)^-(int32_t)(u&1))==-123);if(f==63)assert((u>>1)==2508);if(f==64)assert(u==100653);if(f==65)assert(u==101000);if(f==66)assert(u==5);if(f==67||f==68)assert(u==1);if(f==69)assert(u==32);}
  t.baro_pressure_pa=NAN;assert(!blackbox_frame(b,sizeof b,&t));}
#endif
 size_t n=blackbox_frame(out,sizeof out,&sample);assert(n&&out[0]=='I');memcpy(out,sentinel,sizeof out);assert(!blackbox_frame(out,n-1,&sample));assert(!memcmp(out,sentinel,sizeof out));assert(!blackbox_frame(NULL,sizeof out,&sample));assert(!blackbox_frame(out,sizeof out,NULL));
 sample.p[0]=NAN;assert(!blackbox_frame(out,sizeof out,&sample));sample.p[0]=FLT_MAX;assert(!blackbox_frame(out,sizeof out,&sample));sample.p[0]=.1f;sample.motor[0]=-.1f;assert(!blackbox_frame(out,sizeof out,&sample));sample.motor[0]=.2f;
 assert(blackbox_end(out,sizeof out)==13);assert(out[0]=='E'&&out[1]==255&&out[12]==0);assert(!blackbox_end(out,12));
 /* Schema 3 header: board, FW version, schema key, loop and filter context. */
 h=blackbox_header(header,sizeof header,&meta);assert(h);
 {const char *want[]={"\nH BobFlight log_schema:4\n","\nH BobFlight board:kakute_f7_hdv\n","\nH BobFlight fw_version:0.2.0-encoder-fixture\n",
   "\nH BobFlight loop_rate_hz:1000 gyro_hz:8000 pid_denom:8\n","\nH BobFlight gyro_lpf_hz:","\nH BobFlight gyro_notch1_hz:","\nH BobFlight gyro_notch1_cutoff_hz:",
   "\nH BobFlight gyro_notch2_hz:","\nH BobFlight gyro_notch2_cutoff_hz:","\nH BobFlight rpm_filter_harmonics:","\nH BobFlight rpm_filter_min_hz:",
   "\nH BobFlight rpm_filter_q_x100:","\nH BobFlight motor_poles:14\n","eRPM=eRPM/100"};
  for(unsigned k=0;k<sizeof want/sizeof want[0];k++){if(!strstr(header,want[k])){fprintf(stderr,"missing %s\n",want[k]);return 1;}}
  assert(!strstr(header,"bfIteration"));
  const char *names=strstr(header,"H Field I name:");assert(names);unsigned commas=0;for(const char *q=names;*q&&*q!='\n';q++)commas+=*q==',';assert(commas+1u==BLACKBOX_FIELD_COUNT);
  assert(strstr(names,"eRPM[0],eRPM[1],eRPM[2],eRPM[3],bfTelemOk,bfFilterFlags,bfEvents,bfLoopCode,bfOverruns\n"));
  assert(!!strstr(names,",baroAlt,")==!!BLACKBOX_HAS_BAROMETER);}
 /* Standard `H motor_poles:` (BB1 QA F1): stock Explorer scales eRPM[] by it (value*200/motor_poles). Exactly one line,
  * equal to the frozen config value (and to `H BobFlight motor_poles`), in the standard key group after the
  * fixed-width rate block (after motor_pwm_protocol, before the BobFlight block and the field definitions).
  * An invalid pole count omits it (Explorer default) and never blocks the log. */
 {const char *std=strstr(header,"\nH motor_poles:14\n");assert(std);assert(!strstr(std+1,"\nH motor_poles:"));
  const char *rate=strstr(header,"H BobFlight log_rate_hz:");assert(rate&&rate+BLACKBOX_RATE_BLOCK_BYTES<=std+1);
  assert(strstr(header,"\nH motor_pwm_protocol:6\nH motor_poles:14\nH BobFlight rate_max_roll:"));
  assert(std<strstr(header,"\nH BobFlight motor_poles:14\n")&&std<strstr(header,"H Field I name:"));
  bf_config_t pc=*config_get();blackbox_metadata_t mp=meta;mp.config=&pc;char hp[BLACKBOX_HEADER_MAX_BYTES];
  pc.motor_poles=36.f;assert(blackbox_header(hp,sizeof hp,&mp)==h&&strstr(hp,"\nH motor_poles:36\n")&&strstr(hp,"\nH BobFlight motor_poles:36\n"));
  pc.motor_poles=4.f;assert(blackbox_header(hp,sizeof hp,&mp)==h-2u&&strstr(hp,"\nH motor_poles:4\n")&&strstr(hp,"\nH BobFlight motor_poles:4\n"));
  const size_t line=strlen("H motor_poles:14\n");
  pc.motor_poles=13.f;assert(blackbox_header(hp,sizeof hp,&mp)==h-line&&!strstr(hp,"H motor_poles:")&&strstr(hp,"\nH BobFlight motor_poles:13\n"));
  pc.motor_poles=0.f;assert(blackbox_header(hp,sizeof hp,&mp)==h-line-1u&&!strstr(hp,"H motor_poles:"));
  pc.motor_poles=38.f;assert(blackbox_header(hp,sizeof hp,&mp)&&!strstr(hp,"H motor_poles:"));
  pc.motor_poles=14.5f;assert(blackbox_header(hp,sizeof hp,&mp)&&!strstr(hp,"H motor_poles:"));}
 {blackbox_metadata_t mb=meta;char hb[BLACKBOX_HEADER_MAX_BYTES];
  mb.board=NULL;assert(blackbox_header(hb,sizeof hb,&mb)&&strstr(hb,"\nH BobFlight board:unknown\n"));
  mb.board="";assert(blackbox_header(hb,sizeof hb,&mb)&&strstr(hb,"\nH BobFlight board:unknown\n"));
  mb.board="bad\nH Firmware revision:x";assert(blackbox_header(hb,sizeof hb,&mb)&&strstr(hb,"\nH BobFlight board:bad_H_Firmware_revision_x\n"));
  /* Worst-case header (95-char revision, 47+-char board, widest gains) fits the 4 KiB session buffer. */
  char rev[96];memset(rev,'R',95);rev[95]=0;char brd[64];memset(brd,'B',63);brd[63]=0;mb.revision=rev;mb.board=brd;mb.loop_hz=8000;mb.gyro_hz=8000;mb.pid_denom=1;
  bf_config_t wide=*config_get();float *fp[]={&wide.rate_max_roll,&wide.rate_max_pitch,&wide.rate_max_yaw,&wide.rate_expo_roll,&wide.rate_center_roll,&wide.pid_roll_p,&wide.pid_roll_i,&wide.pid_roll_d,&wide.pid_pitch_p,&wide.pid_pitch_i,&wide.pid_pitch_d,&wide.pid_yaw_p,&wide.pid_yaw_i,&wide.pid_yaw_d,&wide.gyro_lpf_hz,&wide.gyro_notch1_hz,&wide.gyro_notch1_cutoff_hz,&wide.gyro_notch2_hz,&wide.gyro_notch2_cutoff_hz,&wide.rpm_filter_harmonics,&wide.rpm_filter_min_hz,&wide.rpm_filter_q_x100,&wide.motor_poles};
  for(unsigned k=0;k<sizeof fp/sizeof fp[0];k++){*fp[k]=-1.23456789e-30f;}
  wide.motor_poles=36.f; /* widest: a valid pole count also writes the standard `H motor_poles:36` line (+7 B vs any invalid value) */
  mb.config=&wide;mb.rate_reason="auto-lowered-card-slow";mb.requested_hz=1000;mb.sample_hz=125;
  size_t hw=blackbox_header(hb,sizeof hb,&mb);assert(hw&&hw<sizeof hb);assert(strstr(hb,"\nH BobFlight board:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n"));
  printf("schema 4 header: typical %zu B, worst case %zu B (session buffer 4096 B)\n",h,hw);
  wide.motor_poles=NAN;assert(!blackbox_header(hb,sizeof hb,&mb));}
 /* Proven frame bound: every field at its widest varint still fits. */
 {flight_log_sample_t w={0};w.iteration=UINT32_MAX;w.time_us=UINT32_MAX;w.dt_us=UINT32_MAX;w.dropped=UINT32_MAX;w.overruns=UINT32_MAX;
  for(unsigned a=0;a<3;a++){w.gyro[a]=-2.0e8f;w.gyro_raw[a]=-2.0e8f;w.setpoint[a]=-2.0e9f;w.p[a]=w.i[a]=w.d[a]=w.pid_output[a]=-2.1e6f;w.rc[a]=-1.f;}
  for(unsigned a=0;a<3;a++)w.gyro[a]=1.4e8f; /* error = setpoint - gyro stays in int32 */
  w.rc[3]=1.f;for(unsigned m=0;m<4;m++){w.motor[m]=1.f;w.erpm[m]=UINT32_MAX;}
  w.armed=1;w.mode=2;w.failsafe=2;w.pid_valid=w.gyro_valid=w.rx_fresh=w.output_healthy=1;
  w.telem_ok=BB_TELEM_OK_MAX;w.filter_flags=BB_FILTER_FLAGS_MAX;w.events=BB_EVENTS_MAX;w.loop_code=BB_LOOP_CODE_MAX;
  uint8_t big[BLACKBOX_FRAME_MAX_BYTES+8];size_t wn=blackbox_frame(big,sizeof big,&w);assert(wn&&wn<=BLACKBOX_FRAME_MAX_BYTES);
  assert(blackbox_frame(big,BLACKBOX_FRAME_MAX_BYTES,&w)==wn); /* the session packet size is always enough */
  printf("schema 4 frame: widest reachable %zu B <= proven bound %u B; fixture %zu B\n",wn,(unsigned)BLACKBOX_FRAME_MAX_BYTES,blackbox_frame(big,sizeof big,&sample));
  /* Out-of-range schema 4 values are rejected, not truncated. */
  flight_log_sample_t bad=sample;bad.telem_ok=16;assert(!blackbox_frame(big,sizeof big,&bad));
  bad=sample;bad.filter_flags=128;assert(!blackbox_frame(big,sizeof big,&bad));
  bad=sample;bad.events=128;assert(!blackbox_frame(big,sizeof big,&bad));
  bad=sample;bad.loop_code=33;assert(!blackbox_frame(big,sizeof big,&bad));
  /* eRPM is logged as eRPM/100, truncated: 12399 -> 123, 99 -> 0. Last 9 varints = eRPM[0..3]+5 flag/counter fields. */
  flight_log_sample_t e=sample;e.erpm[0]=12399;e.erpm[1]=99;e.erpm[2]=100;e.erpm[3]=0;e.telem_ok=0xF;e.filter_flags=0x45;e.events=0x21;e.loop_code=32;e.overruns=5;
  size_t en=blackbox_frame(big,sizeof big,&e);assert(en>=10);
  const uint8_t tail[]={123,0,1,0,0x0F,0x45,0x21,32,5};assert(!memcmp(big+en-sizeof tail,tail,sizeof tail));}
 if(argc>1){FILE *f=fopen(argv[1],"wb");assert(f);h=blackbox_header(header,sizeof header,&meta);assert(fwrite(header,1,h,f)==h);for(unsigned j=0;j<600;j++){sample.iteration=j*2;sample.time_us=10000+j*2000;
  /* Schema 3 extras vary per frame for the in-repo decoder test (host_blackbox_decode.py). */
  for(unsigned m=0;m<4;m++){sample.erpm[m]=j*1000u+m*37u+57u;}
  sample.telem_ok=(uint8_t)(j%16u);sample.filter_flags=(uint8_t)(j%128u);
  sample.events=(uint8_t)((j*7u)%128u);sample.loop_code=(uint8_t)(j%33u);sample.overruns=j*3u;
  n=blackbox_frame(out,sizeof out,&sample);assert(n&&fwrite(out,1,n,f)==n);}n=blackbox_end(out,sizeof out);assert(fwrite(out,1,n,f)==n);assert(!fclose(f));}
 puts("PASS original C encoder: capacity/no partial write, negative terms, finite/overflow, truthful metadata, gains, sample ratio, DShot300/600, log end; schema 4 header keys, 71 fields, eRPM/100, flag ranges, proven frame bound");
}
