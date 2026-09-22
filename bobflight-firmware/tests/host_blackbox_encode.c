/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_encode.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <float.h>
int main(int argc,char **argv){
 config_init();blackbox_metadata_t meta={500,1000,300,"0.2.0-encoder-fixture",config_get()};
 char header[4096];size_t h=blackbox_header(header,sizeof header,&meta);assert(h&&h<sizeof header);assert(strstr(header,"H Firmware revision:BobFlight 0.2.0-encoder-fixture"));assert(strstr(header,"H I interval:2\nH P interval:1/2\n"));assert(strstr(header,"H looptime:1000\n"));assert(strstr(header,"H BobFlight pid_roll_p:"));
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
