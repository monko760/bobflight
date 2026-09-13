/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0.
 * Private implementation included by cli.c after cli_write_str.
 * Provides bounded ports and modes CLI commands and safe receiver UART configuration.
 */
#ifndef BOBFLIGHT_PORTS_MODES_CLI_H
#define BOBFLIGHT_PORTS_MODES_CLI_H

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>
#include <math.h>

#include "board/board.h"
#include "drivers/rx.h"
#include "drivers/crsf.h"
#include "drivers/bench_parse.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/mode_range.h"

typedef struct {
    unsigned uart;
    const char *tx_pin;
    const char *rx_pin;
} kakute_uart_pin_map_t;

static const kakute_uart_pin_map_t g_kakute_uart_pins[] = {
    {1, "PA9", "PA10"},
    {2, "PD5", "PD6"},
    {3, "PB10", "PB11"},
    {4, "PA0", "PA1"},
    {6, "PC6", "PC7"},
    {7, "-", "PE7"},
};

static void cmd_ports(void)
{
    const board_t *b = board_get();
    char buf[512];
    bool is_armed = (arming_state() == ARM_ARMED);
    bool is_bench = bench_motor_active();
    const char *board_id = (b && b->board_id[0]) ? b->board_id : "?";
    unsigned rx_uart = b ? b->rx_uart : 0;

    int n = snprintf(buf, sizeof(buf),
        "ports_api: 1\r\n"
        "board: %s\r\n"
        "receiver_uart: %u\r\n"
        "reboot_required: no\r\n"
        "persistence: session\r\n"
        "armed: %u\r\n"
        "bench_active: %u\r\n"
        "port: 0,USB_VCP,-,-,cli,0\r\n",
        board_id, rx_uart, is_armed ? 1 : 0, is_bench ? 1 : 0);
    if (n < 0 || (size_t)n >= sizeof(buf)) {
        cli_write_str("ports response failed: overflow\r\n");
        return;
    }
    cli_write_str(buf);

    if (b && strcmp(b->board_id, "kakute_f7_hdv") == 0) {
        for (size_t i = 0; i < sizeof(g_kakute_uart_pins)/sizeof(g_kakute_uart_pins[0]); i++) {
            unsigned u = g_kakute_uart_pins[i].uart;
            const char *role = (u == rx_uart) ? "crsf" : "none";
            n = snprintf(buf, sizeof(buf),
                "port: %u,UART%u,%s,%s,%s,1\r\n",
                u, u, g_kakute_uart_pins[i].tx_pin, g_kakute_uart_pins[i].rx_pin, role);
            if (n > 0 && (size_t)n < sizeof(buf)) {
                cli_write_str(buf);
            }
        }
    } else if (b && !b->is_dummy && rx_uart > 0) {
        /* Other boards expose only actual IR RX nonselectable */
        n = snprintf(buf, sizeof(buf),
            "port: %u,UART%u,-,-,crsf,0\r\n",
            rx_uart, rx_uart);
        if (n > 0 && (size_t)n < sizeof(buf)) {
            cli_write_str(buf);
        }
    }
    /* dummy board: no invented RX lines */

    cli_write_str("ports_end: 1\r\n");
}

static void cmd_modes(void)
{
    char buf[512];
    bool is_armed = (arming_state() == ARM_ARMED);
    bool is_bench = bench_motor_active();
    bool fresh = rx_frame_fresh();

    unsigned flight_enabled = 0;
#if defined(BOBFLIGHT_MCU) && defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    flight_enabled = 1;
#endif

    int n = snprintf(buf, sizeof(buf),
        "modes_api: 1\r\n"
        "persistence: session\r\n"
        "semantics: preview\r\n"
        "flight_enabled: %u\r\n"
        "armed: %u\r\n"
        "bench_active: %u\r\n"
        "rx_fresh: %u\r\n",
        flight_enabled, is_armed ? 1 : 0, is_bench ? 1 : 0, fresh ? 1 : 0);
    if (n < 0 || (size_t)n >= sizeof(buf)) {
        cli_write_str("modes response failed: overflow\r\n");
        return;
    }
    cli_write_str(buf);

    /* Mode rows */
    const mode_config_t *arm_cfg = mode_range_get(MODE_ARM);
    const mode_config_t *angle_cfg = mode_range_get(MODE_ANGLE);

    if (arm_cfg) {
        n = snprintf(buf, sizeof(buf),
            "mode: ARM,%u,%u,%u,%u,%u\r\n",
            arm_cfg->enabled ? 1 : 0,
            (unsigned)arm_cfg->aux_channel,
            (unsigned)arm_cfg->min_us,
            (unsigned)arm_cfg->max_us,
            mode_range_is_active(MODE_ARM) ? 1 : 0);
        if (n > 0 && (size_t)n < sizeof(buf)) {
            cli_write_str(buf);
        }
    }

    if (angle_cfg) {
        n = snprintf(buf, sizeof(buf),
            "mode: ANGLE,%u,%u,%u,%u,%u\r\n",
            angle_cfg->enabled ? 1 : 0,
            (unsigned)angle_cfg->aux_channel,
            (unsigned)angle_cfg->min_us,
            (unsigned)angle_cfg->max_us,
            mode_range_is_active(MODE_ANGLE) ? 1 : 0);
        if (n > 0 && (size_t)n < sizeof(buf)) {
            cli_write_str(buf);
        }
    }

    cli_write_str("modes_end: 1\r\n");
}

static bool parse_digits_only_u32(const char *token, uint32_t *out_val)
{
    if (!token || !*token) {
        return false;
    }
    uint64_t val = 0;
    for (size_t i = 0; token[i] != '\0'; i++) {
        if (!isdigit((unsigned char)token[i])) {
            return false;
        }
        val = val * 10u + (uint64_t)(token[i] - '0');
        if (val > 100000u) {
            return false;
        }
    }
    *out_val = (uint32_t)val;
    return true;
}

static void cmd_mode_range_handle(const char *line)
{
    char line_copy[128];
    strncpy(line_copy, line, sizeof(line_copy) - 1);
    line_copy[sizeof(line_copy) - 1] = '\0';

    char *tokens[8];
    int num_tokens = 0;
    char *p = line_copy;

    while (*p != '\0') {
        while (*p == ' ' || *p == '\t') {
            p++;
        }
        if (*p == '\0') {
            break;
        }
        if (num_tokens >= 7) {
            num_tokens = 8;
            break;
        }
        tokens[num_tokens++] = p;
        while (*p != '\0' && *p != ' ' && *p != '\t') {
            p++;
        }
        if (*p != '\0') {
            *p = '\0';
            p++;
        }
    }

    if (num_tokens != 6) {
        cli_write_str("mode_range refused: invalid parameters\r\n");
        return;
    }

    mode_id_t mode;
    if (strcmp(tokens[1], "ARM") == 0) {
        mode = MODE_ARM;
    } else if (strcmp(tokens[1], "ANGLE") == 0) {
        mode = MODE_ANGLE;
    } else {
        cli_write_str("mode_range refused: invalid mode\r\n");
        return;
    }

    uint32_t enabled_u32, aux_u32, min_u32, max_u32;
    if (!parse_digits_only_u32(tokens[2], &enabled_u32) || (enabled_u32 != 0 && enabled_u32 != 1)) {
        cli_write_str("mode_range refused: enabled must be 0 or 1\r\n");
        return;
    }

    if (!parse_digits_only_u32(tokens[3], &aux_u32) || aux_u32 < 1 || aux_u32 > 12) {
        cli_write_str("mode_range refused: aux must be 1..12\r\n");
        return;
    }

    if (!parse_digits_only_u32(tokens[4], &min_u32) || min_u32 < 900 || min_u32 > 2100) {
        cli_write_str("mode_range refused: min must be 900..2100\r\n");
        return;
    }

    if (!parse_digits_only_u32(tokens[5], &max_u32) || max_u32 < 900 || max_u32 > 2100) {
        cli_write_str("mode_range refused: max must be 900..2100\r\n");
        return;
    }

    if (min_u32 >= max_u32) {
        cli_write_str("mode_range refused: min must be less than max\r\n");
        return;
    }

    if (arming_state() == ARM_ARMED || bench_motor_active()) {
        cli_write_str("mode_range refused: disarmed and motors stopped required\r\n");
        return;
    }

    if (!mode_range_set(mode, enabled_u32 == 1, (uint8_t)aux_u32, (uint16_t)min_u32, (uint16_t)max_u32)) {
        cli_write_str("mode_range refused: set failed\r\n");
        return;
    }

    cmd_modes();
}

static void cmd_receiver_uart_handle(const char *line)
{
    char line_copy[128];
    strncpy(line_copy, line, sizeof(line_copy) - 1);
    line_copy[sizeof(line_copy) - 1] = '\0';

    char *tokens[4];
    int num_tokens = 0;
    char *p = line_copy;

    while (*p != '\0') {
        while (*p == ' ' || *p == '\t') {
            p++;
        }
        if (*p == '\0') {
            break;
        }
        if (num_tokens >= 3) {
            num_tokens = 4;
            break;
        }
        tokens[num_tokens++] = p;
        while (*p != '\0' && *p != ' ' && *p != '\t') {
            p++;
        }
        if (*p != '\0') {
            *p = '\0';
            p++;
        }
    }

    if (num_tokens != 2) {
        cli_write_str("receiver UART refused\r\n");
        return;
    }

    uint32_t uart_u32;
    if (!parse_digits_only_u32(tokens[1], &uart_u32)) {
        cli_write_str("receiver UART refused\r\n");
        return;
    }

    if (arming_state() != ARM_ARMED && !bench_motor_active() && board_select_rx_uart((unsigned)uart_u32)) {
        failsafe_reset_rx_link();
        rx_init();
        cli_write_str("receiver UART changed (until reboot)\r\n");
    } else {
        cli_write_str("receiver UART refused\r\n");
    }
}

static bool cmd_ports_modes_command(const char *line)
{
    if (!line) {
        return false;
    }

    if (strcmp(line, "ports") == 0) {
        cmd_ports();
        return true;
    }

    if (strcmp(line, "modes") == 0) {
        cmd_modes();
        return true;
    }

    if (strncmp(line, "mode_range", 10) == 0 && (line[10] == '\0' || line[10] == ' ' || line[10] == '\t')) {
        cmd_mode_range_handle(line);
        return true;
    }

    if (strncmp(line, "receiver_uart", 13) == 0 && (line[13] == '\0' || line[13] == ' ' || line[13] == '\t')) {
        cmd_receiver_uart_handle(line);
        return true;
    }

    return false;
}

#endif /* BOBFLIGHT_PORTS_MODES_CLI_H */
