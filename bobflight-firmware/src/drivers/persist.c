/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RAM persist stub for config blob (flash later).
 */
#include "drivers/persist.h"
#include "flight/config.h"

#include <string.h>

static bf_config_t g_saved;
static int g_have_saved;

void persist_init(void)
{
    config_init();
    g_have_saved = 0;
}

bool persist_load(void)
{
    if (!g_have_saved) {
        return false;
    }
    config_load_blob(&g_saved);
    return true;
}

bool persist_save(void)
{
    const bf_config_t *src = config_blob();
    if (!src) {
        return false;
    }
    g_saved = *src;
    g_have_saved = 1;
    return true;
}
