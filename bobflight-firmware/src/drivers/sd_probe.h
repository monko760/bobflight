/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SD_PROBE_H
#define BOBFLIGHT_SD_PROBE_H
#include "drivers/sd_spi.h"
typedef enum {SD_PROBE_IDLE,SD_PROBE_INIT,SD_PROBE_MBR,SD_PROBE_BOOT,SD_PROBE_DONE,SD_PROBE_ERROR,SD_PROBE_CANCELLED} sd_probe_phase_t;
typedef struct {
 sd_spi_t card;
 uint8_t sector[512];
 sd_probe_phase_t phase;
 const char *filesystem,*detail;
 uint32_t partition_lba,partition_sectors,cluster_bytes;
 uint64_t volume_sectors;
 uint16_t volume_flags;
} sd_probe_t;
/* Asynchronous, read-only classification. It neither mounts nor repairs a filesystem. */
bool sd_probe_start(sd_probe_t *p,const sd_spi_io_t *io,uint64_t now);
void sd_probe_poll(sd_probe_t *p,uint64_t now);
bool sd_probe_busy(const sd_probe_t *p);
/* Caller must also cancel the hardware exchange before rebinding it. */
void sd_probe_cancel(sd_probe_t *p);
#endif
