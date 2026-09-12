/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parameter persist stub — RAM defaults; flash later.
 */
#ifndef BOBFLIGHT_PERSIST_H
#define BOBFLIGHT_PERSIST_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void persist_init(void);
bool persist_load(void);
bool persist_save(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_PERSIST_H */
