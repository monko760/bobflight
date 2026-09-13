/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_PID_DIAG_CLI_H
#define BOBFLIGHT_PID_DIAG_CLI_H

#include "flight/pid_diag.h"
#include <string.h>

static bool cmd_pid_diag_command(const char *line)
{
    if (!line) {
        return false;
    }
    if (strcmp(line, "pid_diag") == 0 || strncmp(line, "pid_diag ", 9) == 0) {
        char response[1024];
        pid_diag_cli_process(line, response, sizeof(response));
        cli_write_str(response);
        return true;
    }
    return false;
}

#endif /* BOBFLIGHT_PID_DIAG_CLI_H */
