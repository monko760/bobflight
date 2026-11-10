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
const char *persist_accel_storage(void);
/* True only when the last verified save (or boot load) record carries the
 * accelerometer calibration (`storage` line accel_cal_saved: yes|no). */
bool persist_accel_calibration_saved(void);
const char *persist_last_error(void);
const char *persist_backend(void);
uint32_t persist_generation(void);
const char *persist_state(void);
#ifdef __cplusplus
}
#endif
#endif
