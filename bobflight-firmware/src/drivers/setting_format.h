/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_SETTING_FORMAT_H
#define BOBFLIGHT_SETTING_FORMAT_H
#include <stdio.h>
#include <stddef.h>

/* The one `get <key>` value format (`<key>=<%.6g>` CRLF). `defaults <group>`
 * prints its `defaults_key:` lines through this too, so both always agree. */
static int setting_format_line(char *buf, size_t cap, const char *prefix, const char *key, float value)
{
    return snprintf(buf, cap, "%s%s=%.6g\r\n", prefix ? prefix : "", key, (double)value);
}
#endif
