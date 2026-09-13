/* SPDX-License-Identifier: Apache-2.0
 * Schema 1: little-endian binary32 rates/PID, UART, input map, two preview ranges.
 * Byte offsets: floats 0..47; UART 48..51; map 52; mode-count 53; source 54; manual mode 55;
 * MODE_COUNT mode rows from byte 56: enabled, AUX, minLE16, maxLE16, reservedLE16.
 * Store requested configuration only, never effective mode, live telemetry or arming.
 */
#include "drivers/persist.h"
#include "drivers/config_store.h"
#include "flight/config.h"
#include "flight/mode_range.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "drivers/gyro.h"
#include "drivers/crsf.h"
#include "drivers/rx.h"
#include "sched/tasks.h"
#include "board/board.h"
#include <string.h>
#include <math.h>
#include <float.h>

#define PAYLOAD_BYTES 96u
_Static_assert(MODE_COUNT == 2 || MODE_COUNT == 4, "Update persistence schema for new mode model");
_Static_assert(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24, "binary32 config required");
static const char *keys[12]={"rate_max_roll","rate_max_pitch","rate_max_yaw","rate_expo",
 "pid_roll_p","pid_roll_i","pid_roll_d","pid_pitch_p","pid_pitch_i","pid_pitch_d","pid_yaw_p","pid_yaw_i"};
static uint8_t saved[PAYLOAD_BYTES];
static bool have_saved,load_error;
static const char *last_error="none";
static void put32(uint8_t *p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(i*8));}
static uint32_t get32(const uint8_t *p){uint32_t v=0;for(unsigned i=0;i<4;i++)v|=(uint32_t)p[i]<<(i*8);return v;}
static void put16(uint8_t *p,uint16_t v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static uint16_t get16(const uint8_t *p){return (uint16_t)(p[0]|((uint16_t)p[1]<<8));}
static uint32_t board_tag(void){const board_t *b=board_get();uint32_t h=2166136261u;if(!b)return 0;for(const unsigned char *p=(const unsigned char *)b->board_id;*p;p++)h=(h^*p)*16777619u;return h;}
static bool valid_uart(uint32_t u){const board_t *b=board_get();if(!b)return false;if(strcmp(b->board_id,"kakute_f7_hdv"))return u==b->rx_uart;return u==1||u==2||u==3||u==4||u==6||u==7;}
static bool decode(const uint8_t *p,float values[12],mode_config_t modes[MODE_COUNT]){
 for(unsigned i=0;i<12;i++){uint32_t bits=get32(p+i*4);memcpy(&values[i],&bits,4);float v=values[i];
  if(!isfinite(v)||(i<3?(v<10.f||v>2000.f):i==3?(v<0.f||v>1.f):(v<0.f||v>10.f)))return false;
 }
 if(!valid_uart(get32(p+48))||p[52]>1||(p[53]!=2&&p[53]!=4)||p[53]>MODE_COUNT||p[54]>1||p[55]>(p[53]==4?2:1))return false;
#if !defined(BOBFLIGHT_CONTROL_SOURCE_API)
 if(p[54])return false;
#endif
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
 if(p[54]||p[55])return false;
#endif
 if(p[53]==2&&p[54])return false;
 for(unsigned i=56u+p[53]*8u;i<PAYLOAD_BYTES;i++)if(p[i])return false;
 for(unsigned i=0;i<MODE_COUNT;i++){
  if(i>=p[53]){const mode_config_t *d=mode_range_get((mode_id_t)i);if(!d)return false;modes[i]=*d;continue;}
  const uint8_t *r=p+56+i*8;if(r[0]>1||r[1]<1||r[1]>12||r[6]||r[7])return false;
  modes[i]=(mode_config_t){r[0]!=0,r[1],get16(r+2),get16(r+4)};
  if(modes[i].min_us<900||modes[i].max_us>2100||modes[i].min_us>=modes[i].max_us)return false;
 }
 return true;
}
static bool encode(uint8_t p[PAYLOAD_BYTES]){
 const board_t *b=board_get();if(!b)return false;memset(p,0,PAYLOAD_BYTES);
 for(unsigned i=0;i<12;i++){float v;uint32_t bits;if(!config_get_key(keys[i],&v))return false;memcpy(&bits,&v,4);put32(p+i*4,bits);}
 put32(p+48,b->rx_uart);const char *map=crsf_map();if(strcmp(map,"AETR")&&strcmp(map,"TAER"))return false;p[52]=(uint8_t)!strcmp(map,"TAER");p[53]=MODE_COUNT;p[55]=(uint8_t)control_mode_get();
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 p[54]=(uint8_t)!strcmp(control_source_name(),"aux");
#endif
 for(unsigned i=0;i<MODE_COUNT;i++){const mode_config_t *m=mode_range_get((mode_id_t)i);if(!m)return false;uint8_t *r=p+56+i*8;r[0]=m->enabled;r[1]=m->aux_channel;put16(r+2,m->min_us);put16(r+4,m->max_us);}
 float values[12];mode_config_t modes[MODE_COUNT];return decode(p,values,modes);
}
static const char *store_error(config_store_result_t r){switch(r){case CONFIG_STORE_EMPTY:return "empty";case CONFIG_STORE_UNSUPPORTED:return "unsupported";case CONFIG_STORE_INVALID:return "invalid_record";case CONFIG_STORE_IO_ERROR:return "storage_io";default:return "none";}}
static bool safe_to_change(void){
 if(arming_state()==ARM_ARMED){last_error="armed";return false;}
 if(bench_motor_active()){last_error="bench_active";return false;}
 if(gyro_manual_calibration_active()){last_error="calibration_active";return false;}
 return true;
}
void persist_init(void){config_init();mode_range_init();(void)crsf_set_map("AETR");have_saved=false;load_error=false;last_error="none";memset(saved,0,sizeof(saved));}
bool persist_load(void){
 if(!safe_to_change())return false;
 uint8_t p[PAYLOAD_BYTES];config_store_result_t r=config_store_load(board_tag(),p,sizeof(p));
 if(r!=CONFIG_STORE_OK){last_error=store_error(r);load_error=r!=CONFIG_STORE_EMPTY&&r!=CONFIG_STORE_UNSUPPORTED;return false;}
 float values[12];mode_config_t modes[MODE_COUNT];if(!decode(p,values,modes)){last_error="invalid_settings";load_error=true;return false;}
 /* All validation precedes mutation. Known board UART setters cannot fail after validation. */
 const board_t *b=board_get();uint32_t uart=get32(p+48);
 if(uart!=b->rx_uart&&!board_select_rx_uart(uart)){last_error="invalid_uart";load_error=true;return false;}
 for(unsigned i=0;i<12;i++)(void)config_set_key(keys[i],values[i]);
 (void)crsf_set_map(p[52]?"TAER":"AETR");
 for(unsigned i=0;i<MODE_COUNT;i++)(void)mode_range_set((mode_id_t)i,modes[i].enabled,modes[i].aux_channel,modes[i].min_us,modes[i].max_us);
 (void)control_mode_set((control_mode_t)p[55]);
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 (void)control_source_set(p[54]!=0);
#endif
 failsafe_reset_rx_link();rx_init();memcpy(saved,p,sizeof(saved));have_saved=true;load_error=false;last_error="none";return true;
}
bool persist_save(void){
 if(!safe_to_change())return false;
#if defined(BOBFLIGHT_MCU) && defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
 last_error="flight_build_unqualified";return false;
#endif
 uint8_t p[PAYLOAD_BYTES];if(!encode(p)){last_error="invalid_settings";return false;}
 config_store_result_t r=config_store_save(board_tag(),p,sizeof(p));
 if(r!=CONFIG_STORE_OK){last_error=store_error(r);return false;}
 uint8_t check[PAYLOAD_BYTES];r=config_store_load(board_tag(),check,sizeof(check));
 if(r!=CONFIG_STORE_OK||memcmp(p,check,sizeof(p))){last_error="verify_failed";return false;}
 memcpy(saved,p,sizeof(saved));have_saved=true;load_error=false;last_error="none";return true;
}
bool persist_dirty(void){uint8_t now[PAYLOAD_BYTES];return !have_saved||!encode(now)||memcmp(now,saved,sizeof(saved))!=0;}
const char *persist_last_error(void){return last_error;}
const char *persist_backend(void){return config_store_backend();}
uint32_t persist_generation(void){return config_store_generation();}
const char *persist_state(void){if(!config_store_supported())return "unsupported";if(load_error||(strcmp(last_error,"none")&&strcmp(last_error,"empty")))return "error";if(!have_saved)return "defaults";return persist_dirty()?"dirty":"saved";}
