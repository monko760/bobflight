/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "hal/hal.h"
#include <string.h>

bool hal_flash_read(uint32_t offset, void *dst, size_t len)
{
    (void)offset;
    if (dst && len) {
        memset(dst, 0xff, len);
    }
    return false;
}

bool hal_flash_write(uint32_t offset, const void *src, size_t len)
{
    (void)offset;
    (void)src;
    (void)len;
    return false;
}
