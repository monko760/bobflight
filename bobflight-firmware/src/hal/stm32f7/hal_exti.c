/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "hal_f7_priv.h"

bool hal_exti_attach(hal_pin_t pin, hal_exti_cb_t cb, void *ctx)
{
    unsigned port, num;
    (void)cb;
    (void)ctx;
    if (!hal_f7_mmio_ok(pin, &port, &num)) {
        return false;
    }
#if defined(BOBFLIGHT_HAVE_CMSIS)
    (void)port;
    (void)num;
    return true; /* SYSCFG/EXTI programming later */
#else
    (void)port;
    (void)num;
    return false;
#endif
}
