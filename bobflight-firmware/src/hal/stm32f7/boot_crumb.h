/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F7_BOOT_CRUMB_COMPAT_H
#define BOBFLIGHT_F7_BOOT_CRUMB_COMPAT_H
#include "hal/boot_crumb.h"
/* Existing F7-only name remains a source alias, not a portable pin promise. */
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
#define boot_pa2_crude_short_pulse hal_boot_diagnostic_pulse
#endif
#endif
