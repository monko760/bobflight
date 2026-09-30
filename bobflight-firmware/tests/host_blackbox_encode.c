/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_encode.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <float.h>
int main(int argc,char **argv){ config_init();blackbox_metadata_t meta={500,1000,300,"0.2.0-encoder-fixture",config_get(),0,NULL};
 char header[4096];size_t h=blackbox_header(header,sizeof header,&meta);assert(h&&h<sizeof header);assert(strstr(header,"H Firmware revision:BobFlight 0.2.0-encoder-fixture"));assert(strstr(header,"H I interval:2\nH P interval:1/2\n"));assert(strstr(header,"H looptime:1000\n"));assert(strstr(header,"H BobFlight pid_roll_p:"));assert(strstr(header,"H BobFlight pid_yaw_d:"));
 assert(strstr(header,"H BobFlight log_rate_hz:500 requested_hz:500 reason:default "));
 /* Fixed-length rate block in sector 0 for every supported rate/reason/loop, so
  * an effective-rate change can be patched in place without moving bytes. */
 {const uint32_t loops[]={1000,4000,8000},rates[]={1000,500,250,125};const char *reasons[]={"default","auto-lowered-card-slow"};
  for(unsigned l=0;l<3;l++){size_t base=0;
   for(unsigned r=0;r<4;r++)for(unsigned k=0;k<2;k++){
    if(loops[l]%rates[r])continue;
    blackbox_metadata_t m2=meta;m2.loop_hz=loops[l];m2.sample_hz=rates[r];m2.requested_hz=1000;m2.rate_reason=reasons[k];
    char h2[4096];size_t n2=blackbox_header(h2,sizeof h2,&m2);assert(n2);if(!base)base=n2;assert(n2==base);
    const char *line=strstr(h2,"H BobFlight log_rate_hz:");assert(line);const char *eol=strchr(line,'\n');assert(eol&&eol-h2<512);
    const char *iv=strstr(h2,"H I interval:");assert(iv&&line-iv<(long)BLACKBOX_RATE_BLOCK_BYTES);
   }}
  blackbox_metadata_t m3=meta;m3.sample_hz=125;char h3[4096];assert(blackbox_header(h3,sizeof h3,&m3)&&strstr(h3,"H I interval:8\nH P interval:1/8\n"));
  m3.requested_hz=250;m3.sample_hz=500;assert(!blackbox_header(h3,sizeof h3,&m3)); /* effective never above requested */
  m3.requested_hz=500;m3.rate_reason="Bad Reason";assert(!blackbox_header(h3,sizeof h3,&m3));
  m3.rate_reason="auto-lowered-card-slow-and-way-too-long";assert(!blackbox_header(h3,sizeof h3,&m3));}
 char small[16];memset(small,0x5a,sizeof small);assert(!blackbox_header(small,sizeof small,&meta));for(unsigned n=0;n<sizeof small;n++)assert(small[n]==0x5a);
 meta.revision="bad\nH Firmware revision:Betaflight 4.5.0";assert(!blackbox_header(header,sizeof header,&meta));meta.revision="Betaflight 4.5.0";assert(!blackbox_header(header,sizeof header,&meta));meta.revision="0.2.0-encoder-fixture";meta.dshot_kbps=600;assert(blackbox_header(header,sizeof header,&meta));assert(strstr(header,"H motor_pwm_protocol:7\n"));meta.dshot_kbps=300;
 uint8_t out[256],sentinel[256];memset(out,0x5a,sizeof out);memcpy(sentinel,out,sizeof out);
 flight_log_sample_t sample={.dt_us=1000,.gyro={25,-12.5f,4},.gyro_raw={26,-13,4},.setpoint={35,-10,5},.p={.1f,-.02f,.005f},.i={-.01f,.004f,0},.d={.005f,-.002f,0},.pid_output={.095f,-.018f,.005f},.motor={.2f,.4f,.6f,.8f},.rc={.1f,-.05f,.02f,.25f},.armed=1,.mode=1};
 size_t n=blackbox_frame(out,sizeof out,&sample);assert(n&&out[0]=='I');memcpy(out,sentinel,sizeof out);assert(!blackbox_frame(out,n-1,&sample));assert(!memcmp(out,sentinel,sizeof out));assert(!blackbox_frame(NULL,sizeof out,&sample));assert(!blackbox_frame(out,sizeof out,NULL));
 sample.p[0]=NAN;assert(!blackbox_frame(out,sizeof out,&sample));sample.p[0]=FLT_MAX;assert(!blackbox_frame(out,sizeof out,&sample));sample.p[0]=.1f;sample.motor[0]=-.1f;assert(!blackbox_frame(out,sizeof out,&sample));sample.motor[0]=.2f;
 assert(blackbox_end(out,sizeof out)==13);assert(out[0]=='E'&&out[1]==255&&out[12]==0);assert(!blackbox_end(out,12));
 if(argc>1){FILE *f=fopen(argv[1],"wb");assert(f);h=blackbox_header(header,sizeof header,&meta);assert(fwrite(header,1,h,f)==h);for(unsigned j=0;j<600;j++){sample.iteration=j*2;sample.time_us=10000+j*2000;n=blackbox_frame(out,sizeof out,&sample);assert(n&&fwrite(out,1,n,f)==n);}n=blackbox_end(out,sizeof out);assert(fwrite(out,1,n,f)==n);assert(!fclose(f));}
 puts("PASS original C encoder: capacity/no partial write, negative terms, finite/overflow, truthful metadata, gains, sample ratio, DShot300/600, log end");
}
