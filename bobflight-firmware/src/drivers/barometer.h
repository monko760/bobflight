/* SPDX-License-Identifier: Apache-2.0. Observation only, never a control input. */
#ifndef BF_BAROMETER_H
#define BF_BAROMETER_H
#include "drivers/bmp280.h"
#include <string.h>
#if defined(BOBFLIGHT_BARO)
void barometer_poll(void);
bool barometer_read_snapshot(bmp280_snapshot_t *out);
#else
static inline void barometer_poll(void){}
static inline bool barometer_read_snapshot(bmp280_snapshot_t *out){if(out){memset(out,0,sizeof *out);out->reason="unsupported-backend";out->age_ms=UINT32_MAX;}return false;}
#endif
#endif
