/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_CONFIG_STORE_H
#define BOBFLIGHT_CONFIG_STORE_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
/* Schema 14 (N3): 1024-byte payload. Bytes 0..255 keep the schema 13 layout
 * byte for byte; 256.. is the append-only extension (docs/SETTINGS-PERSISTENCE.md). */
#define CONFIG_STORE_SCHEMA 14u
#define CONFIG_STORE_PAYLOAD_BYTES 1024u
/* The one older record this store still reads (for persist's 13->14 migration). */
#define CONFIG_STORE_SCHEMA_V13 13u
#define CONFIG_STORE_PAYLOAD_BYTES_V13 256u
typedef enum {CONFIG_STORE_OK=0,CONFIG_STORE_EMPTY,CONFIG_STORE_UNSUPPORTED,CONFIG_STORE_INVALID,CONFIG_STORE_IO_ERROR,CONFIG_STORE_INCOMPATIBLE} config_store_result_t;
bool config_store_supported(void);
/* bytes must be CONFIG_STORE_PAYLOAD_BYTES. A schema 13 record is returned as its
 * 256 bytes followed by zeros, with config_store_loaded_schema()==13; the caller
 * migrates. The schema 13 record is never rewritten or erased by load. */
config_store_result_t config_store_load(uint32_t board_id,void *payload,size_t bytes);
/* Always writes schema 14 into the slot not holding the current record. */
config_store_result_t config_store_save(uint32_t board_id,const void *payload,size_t bytes);
uint32_t config_store_generation(void);
/* Schema of the record the last load/save found current: 13, 14, or 0 (none). */
uint32_t config_store_loaded_schema(void);
const char *config_store_backend(void);
#endif
