/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_CONFIG_STORE_H
#define BOBFLIGHT_CONFIG_STORE_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#define CONFIG_STORE_SCHEMA 13u
#define CONFIG_STORE_PAYLOAD_BYTES 256u
typedef enum {CONFIG_STORE_OK=0,CONFIG_STORE_EMPTY,CONFIG_STORE_UNSUPPORTED,CONFIG_STORE_INVALID,CONFIG_STORE_IO_ERROR,CONFIG_STORE_INCOMPATIBLE} config_store_result_t;
bool config_store_supported(void);
config_store_result_t config_store_load(uint32_t board_id,void *payload,size_t bytes);
config_store_result_t config_store_save(uint32_t board_id,const void *payload,size_t bytes);
uint32_t config_store_generation(void);
uint32_t config_store_loaded_schema(void);
const char *config_store_backend(void);
#endif
