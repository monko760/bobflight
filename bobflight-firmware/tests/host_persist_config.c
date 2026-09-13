/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "drivers/config_store.h"
#include "board/board.h"
#include "flight/arming.h"
#include "sched/tasks.h"
#include "flight/mode_range.h"
static board_t board={.board_id="kakute_f7_hdv",.rx_uart=6};
static bool armed,bench,calibrating,supported=true,exists,write_failure,read_failure;
static unsigned saves,rx_resets,freshness_resets,generation;
static uint8_t image[128];static size_t image_len;static uint32_t image_board;
const board_t *board_get(void){return &board;}
bool board_select_rx_uart(unsigned u){if(!(u==1||u==2||u==3||u==4||u==6||u==7))return false;board.rx_uart=u;return true;}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return calibrating;}
static control_mode_t manual_mode=CONTROL_MODE_ANGLE;
control_mode_t control_mode_get(void){return manual_mode;}
bool control_mode_set(control_mode_t mode){manual_mode=mode;return true;}
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
static bool aux_source;
const char *control_source_name(void){return aux_source?"aux":"manual";}
bool control_source_set(bool aux){aux_source=aux;return true;}
#endif
static const char *map="AETR";
const char *crsf_map(void){return map;}
bool crsf_set_map(const char *m){if(strcmp(m,"AETR")&&strcmp(m,"TAER"))return false;map=!strcmp(m,"TAER")?"TAER":"AETR";return true;}
void failsafe_reset_rx_link(void){freshness_resets++;}
void rx_init(void){rx_resets++;}
bool rx_frame_fresh(void){return false;}
const float *rx_channels(void){static float channels[16];return channels;}
bool config_store_supported(void){return supported;}
const char *config_store_backend(void){return supported?"host_sim":"unsupported";}
uint32_t config_store_generation(void){return generation;}
config_store_result_t config_store_load(uint32_t id,void *p,size_t n){if(!supported)return CONFIG_STORE_UNSUPPORTED;if(read_failure)return CONFIG_STORE_IO_ERROR;if(!exists)return CONFIG_STORE_EMPTY;if(n!=image_len||id!=image_board)return CONFIG_STORE_INVALID;memcpy(p,image,n);return CONFIG_STORE_OK;}
config_store_result_t config_store_save(uint32_t id,const void *p,size_t n){saves++;if(!supported)return CONFIG_STORE_UNSUPPORTED;if(write_failure)return CONFIG_STORE_IO_ERROR;if(!exists||n!=image_len||memcmp(p,image,n))generation++;memcpy(image,p,n);image_len=n;image_board=id;exists=true;return CONFIG_STORE_OK;}
/* Include the codec to validate the on-wire byte format, not just happy-path APIs. */
#include "../src/drivers/persist.c"
int main(void){
 persist_init();assert(!persist_load());assert(!strcmp(persist_state(),"defaults"));assert(persist_dirty());
 assert(config_set_key("rate_max_roll",777));assert(board_select_rx_uart(1));assert(crsf_set_map("TAER"));assert(mode_range_set(MODE_ANGLE,false,12,1100,1450));
 assert(control_mode_set(CONTROL_MODE_ACRO));
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 assert(mode_range_set(MODE_ACRO,true,5,1300,1600));assert(mode_range_set(MODE_HORIZON,true,6,1600,1900));assert(control_source_set(true));
#endif
 assert(persist_save());assert(!persist_dirty());assert(!strcmp(persist_state(),"saved"));assert(image_len==PAYLOAD_BYTES);assert(image[48]==1&&image[52]==1&&image[64]==0&&image[65]==12);unsigned seq=generation;
 assert(persist_save());assert(generation==seq);
 board.rx_uart=6;manual_mode=CONTROL_MODE_ANGLE;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 aux_source=false;
#endif
 persist_init();assert(!strcmp(map,"AETR"));assert(mode_range_get(MODE_ANGLE)->aux_channel==2);assert(persist_load());
 float v;assert(config_get_key("rate_max_roll",&v)&&v==777);assert(board.rx_uart==1&&!strcmp(map,"TAER"));assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(!persist_dirty());assert(rx_resets==1&&freshness_resets==1);assert(manual_mode==CONTROL_MODE_ACRO);
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 assert(aux_source);assert(mode_range_get(MODE_ACRO)->aux_channel==5);assert(mode_range_get(MODE_HORIZON)->aux_channel==6);
#endif
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 /* Cold-reset all volatile mode selections, then restore each manual mode/source pair. */
 for(unsigned mode=0;mode<3;mode++)for(unsigned source=0;source<2;source++){
  assert(control_mode_set((control_mode_t)mode));assert(control_source_set(source!=0));assert(persist_save());
  manual_mode=CONTROL_MODE_ANGLE;aux_source=false;persist_init();assert(persist_load());
  assert((unsigned)manual_mode==mode);assert(aux_source==(source!=0));
  assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(mode_range_get(MODE_ACRO)->aux_channel==5);assert(mode_range_get(MODE_HORIZON)->aux_channel==6);
 }
#endif
 unsigned before=saves;armed=true;assert(!persist_save());armed=false;bench=true;assert(!persist_save());bench=false;calibrating=true;assert(!persist_save());calibrating=false;assert(saves==before);
 assert(config_set_key("rate_max_roll",666));write_failure=true;assert(!persist_save());assert(persist_dirty());write_failure=false;assert(persist_load());assert(config_get_key("rate_max_roll",&v)&&v==777);
 uint8_t good[PAYLOAD_BYTES];memcpy(good,image,PAYLOAD_BYTES);
 const unsigned bad_offsets[]={0,3,48,52,53,54,55,64,65,66,67,68,69,70,71};
 for(unsigned i=0;i<sizeof(bad_offsets)/sizeof(bad_offsets[0]);i++){
  memcpy(image,good,PAYLOAD_BYTES);unsigned o=bad_offsets[i];image[o]=255;
  /* Single mantissa bit changes may be valid; explicitly force NaN for float cases. */
  if(o<48){image[0]=0;image[1]=0;image[2]=0xc0;image[3]=0x7f;}
  if(o==66||o==67){image[66]=0;image[67]=0;}if(o==68||o==69){image[68]=0xff;image[69]=0xff;}
  assert(config_set_key("rate_max_roll",444));assert(!persist_load());assert(config_get_key("rate_max_roll",&v)&&v==444);assert(board.rx_uart==1);assert(mode_range_get(MODE_ANGLE)->aux_channel==12);
 }
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 /* Upgrade a two-row schema-1 payload while preserving old settings and new defaults. */
 memcpy(image,good,PAYLOAD_BYTES);image[53]=2;image[54]=0;image[55]=1;memset(image+72,0,PAYLOAD_BYTES-72);
 persist_init();assert(persist_load());assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(!mode_range_get(MODE_ACRO)->enabled);assert(!mode_range_get(MODE_HORIZON)->enabled);assert(persist_dirty());
#endif
 memcpy(image,good,PAYLOAD_BYTES);read_failure=true;assert(!persist_load());read_failure=false;assert(persist_load());supported=false;assert(!persist_save());assert(!strcmp(persist_state(),"unsupported"));
 puts("PASS codec offsets, validated atomic restore, repeated boot-init roundtrip, dirty tracking, guards, failed writes/readback, malformed fields and scope");
}
