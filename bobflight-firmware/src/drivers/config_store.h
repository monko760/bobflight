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
uint32_t config_store_loaded_schema(void);
#endif
