/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_PERSIST_H
#define BOBFLIGHT_PERSIST_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void persist_init(void);
bool persist_load(void);
bool persist_save(void);
bool persist_dirty(void);
const char *persist_last_error(void);
const char *persist_backend(void);
uint32_t persist_generation(void);
const char *persist_state(void);
#ifdef __cplusplus
}
#endif
#endif
