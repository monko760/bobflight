/* SPDX-License-Identifier: Apache-2.0
 * Host test: Explicit, observable legacy p54 (AUX source) -> manual migration.
 * Verifies that loading a legacy schema payload requesting AUX control source (p[54]=1)
 * explicitly migrates control source to manual (control_source_set(false)),
 * preserves stored manual control mode (p[55], e.g. Acro),
 * signals migration via last_error ("migrated_control_source_manual"),
 * reports persist_dirty() == true and persist_state() == "dirty" until explicit save,
 * and after persist_save() updates on-disk storage to p[54]=0, clearing dirty/migration flags.
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "drivers/config_store.h"
#include "drivers/gyro.h"
#include "drivers/sensor_calibration.h"
#include "board/board.h"
#include "flight/arming.h"
#include "sched/tasks.h"
#include "flight/mode_range.h"
#include "drivers/power.h"
#include "hal/hal.h"

static board_t board={.board_id="kakute_f7_hdv",.rx_uart=6};
static bool armed,bench,calibrating,supported=true,exists,write_failure,read_failure;
static unsigned saves,rx_resets,freshness_resets,generation;
static uint8_t image[184];static size_t image_len;static uint32_t image_board;

const board_t *board_get(void){return &board;}
bool board_select_rx_uart(unsigned u){if(!(u==1||u==2||u==3||u==4||u==6||u==7))return false;board.rx_uart=u;return true;}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return calibrating;}

/* Unified build control mode & source semantics matching tasks.c */
static control_mode_t g_control_mode = CONTROL_MODE_ANGLE;
static bool g_control_aux = false;
static bool reject_manual_source;

control_mode_t control_mode_get(void) { return g_control_mode; }
const char *control_mode_name(void) {
    return g_control_mode == CONTROL_MODE_ACRO ? "acro" : g_control_mode == CONTROL_MODE_HORIZON ? "horizon" : "angle";
}
const char *control_source_name(void) { return g_control_aux ? "aux" : "manual"; }

bool control_mode_set(control_mode_t mode) {
    if (mode != CONTROL_MODE_ANGLE && mode != CONTROL_MODE_ACRO && mode != CONTROL_MODE_HORIZON) return false;
    g_control_mode = mode;
    return true;
}

bool control_source_set(bool use_aux) {
    if (use_aux || reject_manual_source) return false; /* AUX mode-range routing retired in unified build */
    g_control_aux = false;
    return true;
}

static const char *map="AETR";
const char *crsf_map(void){return map;}
bool crsf_set_map(const char *m){if(strcmp(m,"AETR")&&strcmp(m,"TAER"))return false;map=!strcmp(m,"TAER")?"TAER":"AETR";return true;}
void failsafe_reset_rx_link(void){freshness_resets++;}
void rx_init(void){rx_resets++;}
static bool restored_fresh;
bool rx_frame_fresh(void){return restored_fresh;}
static float restored_rc[16];
const float *rx_channels(void){return restored_rc;}
bool config_store_supported(void){return supported;}
const char *config_store_backend(void){return supported?"host_sim":"unsupported";}
uint32_t config_store_generation(void){return generation;}
config_store_result_t config_store_load(uint32_t id,void *p,size_t n){if(!supported)return CONFIG_STORE_UNSUPPORTED;if(read_failure)return CONFIG_STORE_IO_ERROR;if(!exists)return CONFIG_STORE_EMPTY;if(n!=image_len||id!=image_board)return CONFIG_STORE_INVALID;memcpy(p,image,n);return CONFIG_STORE_OK;}
config_store_result_t config_store_save(uint32_t id,const void *p,size_t n){saves++;if(!supported)return CONFIG_STORE_UNSUPPORTED;if(write_failure)return CONFIG_STORE_IO_ERROR;if(!exists||n!=image_len||memcmp(p,image,n))generation++;memcpy(image,p,n);image_len=n;image_board=id;exists=true;return CONFIG_STORE_OK;}

static gyro_calibration_info_t cal;
void gyro_calibration_info(gyro_calibration_info_t *out){*out=cal;}
uint32_t gyro_accel_calibration_binding(void){return 0x01006810u;}
bool gyro_accel_restore_valid(const float b[3],const float v[3],uint32_t binding){return binding==gyro_accel_calibration_binding()&&sc_accel_coefficients_valid(b,v);}
void gyro_restore_accel_calibration(const float b[3],const float v[3],bool valid){memcpy(cal.accel_bias,b,12);memcpy(cal.accel_scale,v,12);cal.accel_valid=valid;}
uint32_t config_store_loaded_schema(void){return image_len==96?1:image_len==128?2:image_len==160?3:image_len==176?4:5;}
config_store_result_t config_store_load_v2(uint32_t id,void*p,size_t n){
 if(image_len==96&&n==128&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,96);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v2(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}

void hal_power_adc_init(hal_pin_t a,hal_pin_t b){(void)a;(void)b;}
bool hal_power_adc_poll(uint16_t *a,uint16_t *b){(void)a;(void)b;return false;}
uint32_t hal_millis(void){return 0;}
static unsigned speed=300;static bool speed_failure;
unsigned dshot_speed_kbps(void){return speed;}
bool dshot_set_speed_kbps(unsigned v){if(speed_failure)return false;speed=v;return true;}
config_store_result_t config_store_load_v3(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128)&&n==160&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_load_v4(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128||image_len==160)&&n==176&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v4(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
config_store_result_t config_store_load_v5(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128||image_len==160||image_len==176)&&n==184&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v5(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
config_store_result_t config_store_save_v3(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}

/* Include codec implementation directly */
#include "../src/drivers/persist.c"

int main(void) {
    printf("Starting host_legacy_p54_migration test...\n");
    power_init();
    persist_init();

    /* 1. Setup valid base settings in RAM */
    assert(config_set_key("rate_max_roll", 888.0f));
    assert(config_set_key("pid_roll_p", 2.5f));
    assert(board_select_rx_uart(1));
    assert(crsf_set_map("TAER"));
    assert(control_mode_set(CONTROL_MODE_ACRO));

    assert(mode_range_set(MODE_ARM,true,11,1200,1500));
    assert(mode_range_set(MODE_ANGLE,false,12,1100,1450));
    const power_config_t power={12.25f,27.5f,100.f,6,3.6f,3.2f,1500};
    assert(power_configure(&power));assert(dshot_set_speed_kbps(600));
    cal.accel_valid=true;
    for(unsigned i=0;i<3;i++){cal.accel_bias[i]=0.01f;cal.accel_scale[i]=1.01f;}
    /* 2. Save baseline config to populate image */
    assert(persist_save());
    assert(!persist_dirty());
    assert(strcmp(persist_state(), "saved") == 0);
    assert(image_len == PAYLOAD_BYTES);

    /* 3. Inject legacy p54 = 1 (AUX source requested) into stored image while preserving the saved Acro enum */
    image[54] = 1;
    image[55] = CONTROL_MODE_ACRO; /* stored enum, not wire row index */

    uint8_t legacy[PAYLOAD_BYTES];memcpy(legacy,image,sizeof(legacy));
    const unsigned saves_before_load=saves;
    /* 4. Cold-reset volatile RAM state */
    board.rx_uart=6;map="AETR";speed=300;power_init();memset(&cal,0,sizeof(cal));
    g_control_mode = CONTROL_MODE_ANGLE;
    g_control_aux = false;
    persist_init();
    assert(control_mode_get() == CONTROL_MODE_ANGLE);

    /* 5. Load legacy payload with p54 = 1 */
    assert(persist_load());

    /* 6. Verify observable migration behavior & preserved settings */
    assert(control_mode_get() == CONTROL_MODE_ACRO); /* Stored manual mode preserved! */
    assert(strcmp(control_source_name(), "manual") == 0); /* Control source migrated to manual */
    assert(persist_dirty()); /* Dirty state signaled! */
    assert(strcmp(persist_state(), "dirty") == 0);
    assert(strcmp(persist_last_error(), "migrated_control_source_manual") == 0); /* Explicit last_error migration signal */

    /* Verify non-control settings preserved */
    float rate_val = 0.0f;
    assert(config_get_key("rate_max_roll", &rate_val) && rate_val == 888.0f);
    assert(board.rx_uart == 1);
    assert(strcmp(crsf_map(), "TAER") == 0);

    uint8_t restored[PAYLOAD_BYTES];assert(encode(restored));
    assert(restored[54]==0);restored[54]=1;
    assert(!memcmp(restored,legacy,sizeof(legacy))); /* Every payload byte except source restored. */
    assert(saves==saves_before_load&&!memcmp(image,legacy,sizeof(legacy))); /* No automatic flash write. */
    persist_init();assert(persist_load());
    assert(!strcmp(persist_last_error(),"migrated_control_source_manual")&&persist_dirty());
    assert(saves==saves_before_load); /* Notice survives reboot until Save. */

    /* 7. Verify explicit persist_save() updates storage and clears dirty/migration state */
    assert(persist_save());
    assert(!persist_dirty());
    assert(strcmp(persist_state(), "saved") == 0);
    assert(strcmp(persist_last_error(), "none") == 0);
    assert(image[54] == 0); /* On-disk payload now updated to manual */
    assert(image[55] == CONTROL_MODE_ACRO); /* On-disk manual mode still ACRO */

    /* 8. Verify reloading saved payload loads clean without migration signal */
    g_control_mode = CONTROL_MODE_ANGLE;
    persist_init();
    assert(persist_load());
    assert(control_mode_get() == CONTROL_MODE_ACRO);
    assert(strcmp(control_source_name(), "manual") == 0);
    assert(!persist_dirty());
    assert(strcmp(persist_state(), "saved") == 0);
    assert(strcmp(persist_last_error(), "none") == 0);

    /* Both legacy fallback and ordinary manual-source refusal must report failure. */
    for(unsigned source=0;source<2;source++){
        image[54]=(uint8_t)source;reject_manual_source=true;persist_init();
        assert(!persist_load());assert(!strcmp(persist_last_error(),"control_source_failed"));
        assert(!strcmp(persist_state(),"error"));reject_manual_source=false;
    }
    /* Unsupported persisted mode rejected before UART/setting mutations. */
    image[55]=255;board.rx_uart=6;persist_init();assert(!persist_load());
    assert(board.rx_uart==6&&!strcmp(persist_last_error(),"invalid_settings"));
    printf("PASS: legacy AUX migration, whole payload preservation, no auto-save, repeated boot notice, explicit save, both manual-source refusal paths, invalid mode\n");
    return 0;
}
