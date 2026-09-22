/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * R0b M1 telem snapshot stubs — IC capture body lands next.
 */
#include "drivers/dshot_telem.h"

static bool g_bidir;

void dshot_bidir_set_enabled(bool on)
{
    g_bidir = on;
}

bool dshot_bidir_enabled(void)
{
    return g_bidir;
}

uint32_t dshot_m1_erpm(void)
{
    return 0u;
}

dshot_telem_status_t dshot_m1_telem_status(void)
{
    return g_bidir ? DSHOT_TELEM_NONE : DSHOT_TELEM_NONE;
}

uint32_t dshot_m1_telem_age_ms(void)
{
    return 0u;
}

uint32_t dshot_m1_telem_period_us(void)
{
    return 0u;
}
