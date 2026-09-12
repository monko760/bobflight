/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * USB CDC CLI: help, version, status, arm, disarm, reboot.
 */
#ifndef BOBFLIGHT_CLI_H
#define BOBFLIGHT_CLI_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void cli_init(void);
void cli_poll(void);
bool cli_reboot_requested(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_CLI_H */
