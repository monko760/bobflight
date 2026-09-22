#ifndef BOBFLIGHT_CONFIG_STORE_H
#define BOBFLIGHT_CONFIG_STORE_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
typedef enum { CONFIG_STORE_OK=0,CONFIG_STORE_EMPTY,CONFIG_STORE_UNSUPPORTED,CONFIG_STORE_INVALID,CONFIG_STORE_IO_ERROR } config_store_result_t;
bool config_store_supported(void);
config_store_result_t config_store_load(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save(uint32_t board_id,const void *payload,size_t bytes);
uint32_t config_store_generation(void);
const char *config_store_backend(void);
/* v2 is 128 bytes; accepts and zero-extends only schema1/96-byte records.
 * Save migrates to the alternate slot and commits last; never erases legacy first. */
config_store_result_t config_store_load_v2(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save_v2(uint32_t board_id,const void *payload,size_t bytes);
/* v3 is 160 bytes; accepts schema1/96 and schema2/128 with zero extension. */
config_store_result_t config_store_load_v3(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save_v3(uint32_t board_id,const void *payload,size_t bytes);
/* v4 is 176 bytes; accepts schema1/2/3 with zero extension. Adds min_throttle+airmode. */
config_store_result_t config_store_load_v4(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save_v4(uint32_t board_id,const void *payload,size_t bytes);
/* v5 is 184 bytes; accepts schema1/2/3/4 with zero extension. Adds gyro_lpf_hz+dterm_lpf_hz. */
config_store_result_t config_store_load_v5(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save_v5(uint32_t board_id,const void *payload,size_t bytes);
/* v6 is 188 bytes; accepts schema1/2/3/4/5 with zero extension. Adds pid_yaw_d. */
config_store_result_t config_store_load_v6(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save_v6(uint32_t board_id,const void *payload,size_t bytes);
uint32_t config_store_loaded_schema(void);
#endif
