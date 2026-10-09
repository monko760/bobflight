/* SPDX-License-Identifier: Apache-2.0. Read-only JEDEC/status discovery. */
#ifndef BF_NOR_PROBE_H
#define BF_NOR_PROBE_H
#include <stdbool.h>
#include <stdint.h>
typedef struct {
 void (*select)(bool,void *);
 void (*start)(uint8_t,void *);
 int (*poll)(uint8_t *,void *); /* -1 error, 0 pending, 1 byte complete */
 void (*cancel)(void *);
 void *ctx;
} nor_probe_io_t;
typedef struct {
 nor_probe_io_t io;
 uint64_t started;
 uint8_t id[3],status,step;
 uint32_t capacity;
 bool active,complete,known;
 const char *reason;
} nor_probe_t;
bool nor_probe_begin(nor_probe_t *,const nor_probe_io_t *,uint64_t);
void nor_probe_poll(nor_probe_t *,uint64_t);
void nor_probe_cancel(nor_probe_t *,const char *);
#endif
