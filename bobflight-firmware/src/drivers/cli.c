/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "drivers/cli.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/rx.h"
#include "drivers/crsf.h"
#include "drivers/persist.h"
#include "drivers/power.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/config.h"
#include "board/board.h"
#include "sched/scheduler.h"
#include "hal/hal.h"
#include "flight/attitude.h"
#include "sched/tasks.h"
#include "drivers/bench_parse.h"
#include "bobflight/version.h"

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>

static char g_line[128];
static unsigned g_len;
static bool g_discard_line;

static void cli_write_str(const char *s)
{
    if (!s) {
        return;
    }
    hal_usb_cdc_write((const uint8_t *)s, strlen(s));
}

#include "drivers/sensor_cli.h"
#include "drivers/timing_cli.h"

static void cmd_control_mode(void)
{
    cli_write_str("control_mode_version: 1\r\ncontrol_mode: ");
    cli_write_str(control_mode_name());
    cli_write_str("\r\ncontrol_mode_storage: ram-only\r\n"
                  "control_mode_experimental: yes\r\ncontrol_mode_end: 1\r\n");
}

static void cmd_help(void)
{
    cli_write_str(
        "BobFlight CLI\r\n"
        "  help     - this text\r\n"
        "  control_mode [angle|acro] - experimental RAM-only bench routing\r\n"
        "  version  - firmware version\r\n"
        "  status   - MCU, loops, arm, gyro, board\r\n"
        "  power - battery readings and configuration\r\n"
        "  power_config <divider> <mV/A or 0> <offset_mV> <cells or 0> <warn_V> <critical_V> <mAh> - until reboot\r\n"
        "  get      - get <key>\r\n"
        "  set      - set <key> <value>\r\n"
        "  save     - persist config\r\n"
        "  defaults - restore defaults (no auto-save)\r\n"
        "  sensors / calibration - live samples / calibration diagnostics\r\n"
        "  calibrate_gyro - stationary bias calibration (RAM until reboot)\r\n"
        "  calibrate_accel <start|+x|-x|+y|-y|+z|-z|apply|cancel> - six-face calibration\r\n"
        "  calibration_cancel - cancel, retaining applied coefficients\r\n"
        "  receiver_uart <1|2|3|4|6|7> - receiver port until reboot\r\n"
        "  receiver - CRSF diagnostics and 16 mapped controls\r\n"
        "  receiver_map <AETR|TAER> - input order until reboot\r\n"
        "  motor_test <0..4> - 0 stop; one-second 8% props-off pulse\r\n"
        "  motor_pulse <1..4> <0..35> - one-second adjustable props-off pulse\r\n"
        "  motor_seq - spin motors in order RR FR RL FL (1s each)\r\n"
        "  dshot [300|600] - show or switch DShot bit rate\r\n"
        "  arm      - attempt arm (refuses if gyro unhealthy)\r\n"
        "  disarm   - disarm\r\n"
        "  timing   - read clock and scheduler task health (not sensor sample rate)\r\n"
        "  reboot   - soft reset (host: exit loop flag)\r\n");
}

static void cmd_version(void)
{
    char buf[96];
    snprintf(buf, sizeof(buf), "%s %s\r\n", BOBFLIGHT_PRODUCT_NAME, BOBFLIGHT_VERSION_STRING);
    cli_write_str(buf);
}

static void cmd_status(void)
{
    const board_t *b = board_get();
    const scheduler_stats_t *st = scheduler_stats();
    char buf[1000];
    const float *rates=gyro_latest_dps(),*acc=gyro_accel_g(),*angles=attitude_degrees(),*rc=rx_channels();
    const char *flight="bench-only";
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    flight="angle-prototype";
#endif
    const char *irlab = "none";
    if (b && b->ir_verified) {
        irlab = "verified";
    } else if (b && b->ir_bf_derived) {
        irlab = "bf-derived";
    } else if (b && b->is_dummy) {
        irlab = "dummy";
    }
    snprintf(buf, sizeof(buf),
             "board: %s\r\n"
             "ir: %s\r\n"
             "mcu: %s hse_mhz=%lu\r\n"
             "usb_clk: %s\r\n"
             "gyro_ok: %s\r\n"
             "gyro_bind: %s\r\n"
             "dshot_bound: %u/4\r\n"
             "rx: %s %s\r\n"
             "mmio: %s\r\n"
             "arm: %s\r\n"
             "failsafe: %s\r\n"
             "loop: gyro=%lu Hz denom=%lu cascade=%lu bg=%lu\r\n"
             "flight_mode: %s\r\n"
             "gyro_calibrated: %s\r\n"
             "gyro_dps: %.2f %.2f %.2f\r\n"
             "accel_g: %.3f %.3f %.3f\r\n"
             "attitude_deg: %.2f %.2f\r\n"
             "rx_uart: %u\r\n"
             "rx_fresh: %s\r\n"
             "rx_frames: %lu\r\n"
             "channels: %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f\r\n"
             "motor_output: %s\r\n",
             b ? b->board_id : "?",
             irlab,
             b ? b->mcu_family : "?",
             (unsigned long)(b ? b->hse_mhz : 0),
             hal_clock_usb_src(),
             gyro_is_healthy() ? "yes" : "no",
             gyro_bind_state(),
             dshot_bound_count(),
             rx_protocol_name(),
             rx_uart_bound() ? "bound" : "unbound",
             board_mmio_permitted() ? (b && b->ir_bf_derived && !b->ir_verified ? "allowed (bf-derived)" : "allowed") : "denied",
             arming_state() == ARM_ARMED ? "armed" : "disarmed",
             failsafe_active() ? "ACTIVE" : "ok",
             (unsigned long)(st ? st->gyro_hz : 0),
             (unsigned long)(st ? st->pid_process_denom : 0),
             (unsigned long)(st ? st->cascade_runs : 0),
             (unsigned long)(st ? st->bg_runs : 0),flight,gyro_calibrated()?"yes":"no",
             (double)rates[0],(double)rates[1],(double)rates[2],(double)acc[0],(double)acc[1],(double)acc[2],
             (double)angles[0],(double)angles[1],b?b->rx_uart:0,rx_frame_fresh()?"yes":"no",(unsigned long)rx_frame_count(),
             (double)rc[0],(double)rc[1],(double)rc[2],(double)rc[3],(double)rc[4],(double)rc[5],(double)rc[6],(double)rc[7],
             dshot_is_healthy()?"DShot300 ready":"unavailable");
    cli_write_str(buf);
}

static void cmd_receiver(void)
{
    const board_t *b=board_get();
    const float *ch=rx_channels();
    uint32_t age=rx_frame_age_ms();
    char buf[768];
    const char *link=!rx_uart_bound()?"unbound":age==UINT32_MAX?"waiting":rx_frame_fresh()?"live":"lost";
    snprintf(buf,sizeof(buf),
        "receiver_api: 1\r\nprotocol: CRSF\r\nuart: %u\r\nmap: %s\r\nlink: %s\r\n"
        "age_ms: %ld\r\nframes: %lu\r\ncrc_errors: %lu\r\nstream_resets: %lu\r\n"
        "armed: %u\r\nbench_active: %u\r\nfailsafe: %u\r\n"
        "channels: %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.3f\r\n"
        "persistence: ram\r\nreceiver_end: 1\r\n",
        b?b->rx_uart:0,crsf_map(),link,age==UINT32_MAX?-1L:(long)(age>2147483647u?2147483647u:age),
        (unsigned long)rx_frame_count(),(unsigned long)crsf_crc_errors(),(unsigned long)crsf_stream_resets(),
        arming_state()==ARM_ARMED,bench_motor_active(),failsafe_active(),
        (double)ch[0],(double)ch[1],(double)ch[2],(double)ch[3],(double)ch[4],(double)ch[5],(double)ch[6],(double)ch[7],
        (double)ch[8],(double)ch[9],(double)ch[10],(double)ch[11],(double)ch[12],(double)ch[13],(double)ch[14],(double)ch[15]);
    cli_write_str(buf);
}

static void cmd_power(void)
{
    power_expire(hal_millis());
    const power_state_t *s=power_state();
    const power_config_t *c=power_config();
    char buf[640];
    snprintf(buf,sizeof(buf),
        "power_api: 1\r\nvalid: %u\r\npresent: %u\r\ncurrent_valid: %u\r\nconsumption_valid: %u\r\n"
        "voltage: %.3f\r\namps: %.3f\r\nconsumed_mah: %.3f\r\nwarning: %s\r\n"
        "voltage_scale: %.6g\r\ncurrent_mv_per_amp: %.6g\r\ncurrent_offset_mv: %.6g\r\n"
        "cells: %u\r\nwarning_cell_v: %.3f\r\ncritical_cell_v: %.3f\r\ncapacity_mah: %u\r\n"
        "raw_voltage: %u\r\nraw_current: %u\r\npersistence: ram\r\npower_end: 1\r\n",
        s->valid,s->present,s->current_valid,s->consumption_valid,(double)s->voltage,(double)s->amps,
        (double)s->consumed_mah,power_warning(),(double)c->voltage_scale,(double)c->current_mv_per_amp,
        (double)c->current_offset_mv,c->cells,(double)c->warning_cell_v,(double)c->critical_cell_v,
        c->capacity_mah,s->raw_voltage,s->raw_current);
    cli_write_str(buf);
}

static void cmd_get(const char *key)
{
    float v;
    char buf[64];
    if (!key || !config_get_key(key, &v)) {
        cli_write_str("unknown key\r\n");
        return;
    }
    snprintf(buf, sizeof(buf), "%s=%.6g\r\n", key, (double)v);
    cli_write_str(buf);
}

static void cmd_set(const char *key, const char *valstr)
{
    char *end = NULL;
    float v;
    char buf[72];
    if(arming_state()==ARM_ARMED){cli_write_str("set failed: armed\r\n");return;}
    if (!key) {
        cli_write_str("unknown key\r\n");
        return;
    }
    if (!valstr || !*valstr) {
        cli_write_str("set failed\r\n");
        return;
    }
    v = strtof(valstr, &end);
    if (end == valstr) {
        cli_write_str("set failed\r\n");
        return;
    }
    if (!config_set_key(key, v)) {
        /* distinguish unknown vs invalid */
        float tmp;
        if (!config_get_key(key, &tmp)) {
            cli_write_str("unknown key\r\n");
        } else {
            cli_write_str("set failed\r\n");
        }
        return;
    }
    (void)config_get_key(key, &v);
    snprintf(buf, sizeof(buf), "ok %s=%.6g\r\n", key, (double)v);
    cli_write_str(buf);
}

static volatile bool g_reboot_req;

bool cli_reboot_requested(void)
{
    return g_reboot_req;
}

static void handle_line(char *line)
{
    while (*line == ' ' || *line == '\t') {
        line++;
    }
    char *end = line + strlen(line);
    while (end > line && (end[-1] == '\r' || end[-1] == '\n' || end[-1] == ' ')) {
        *--end = '\0';
    }
    if (*line == '\0') {
        return;
    }

    if (strcmp(line, "help") == 0) {
        cmd_help();
    } else if (strcmp(line, "version") == 0) {
        cmd_version();
    } else if (strcmp(line, "timing") == 0) {
        cmd_timing();
    } else if (strcmp(line, "control_mode") == 0) {
        cmd_control_mode();
    } else if (strncmp(line, "control_mode ", 13) == 0) {
        const char *arg = line + 13;
        bool valid = strcmp(arg, "angle") == 0 || strcmp(arg, "acro") == 0;
        control_mode_t mode = strcmp(arg, "acro") == 0 ? CONTROL_MODE_ACRO : CONTROL_MODE_ANGLE;
        if (valid && control_mode_set(mode)) cmd_control_mode();
        else cli_write_str("control_mode refused: angle|acro; disarmed, motors stopped, "
                           "no calibration; acro requires bench build\r\n");
    } else if (strcmp(line, "status") == 0) {
        cmd_status();
    } else if (strcmp(line, "receiver") == 0) {
        cmd_receiver();
    } else if (strncmp(line,"receiver_map ",13)==0) {
        if (arming_state()!=ARM_ARMED && !bench_motor_active() && crsf_set_map(line+13)) {
            failsafe_reset_rx_link(); rx_init(); cmd_receiver();
        } else cli_write_str("receiver map refused: AETR/TAER, disarmed and motors stopped required\r\n");
    } else if (strcmp(line, "power") == 0) {
        cmd_power();
    } else if (strncmp(line, "power_config ",13)==0) {
        power_config_t c; char extra;
        if (arming_state()==ARM_ARMED || bench_motor_active()) {
            cli_write_str("power_config refused: stop motors and disarm\r\n");
        } else if (sscanf(line+13,"%f %f %f %u %f %f %u %c", &c.voltage_scale,
            &c.current_mv_per_amp,&c.current_offset_mv,&c.cells,&c.warning_cell_v,
            &c.critical_cell_v,&c.capacity_mah,&extra)==7 && power_configure(&c)) {
            cmd_power();
        } else cli_write_str("power_config refused: invalid values\r\n");
    } else if (strncmp(line, "get ", 4) == 0) {
        cmd_get(line + 4);
    } else if (strncmp(line, "set ", 4) == 0) {
        char *key = line + 4;
        char *sp = strchr(key, ' ');
        if (!sp) {
            cli_write_str("set failed\r\n");
        } else {
            *sp = '\0';
            cmd_set(key, sp + 1);
        }
    } else if (strcmp(line, "save") == 0) {
        cli_write_str(arming_state()!=ARM_ARMED && persist_save() ? "saved\r\n" : "save failed\r\n");
    } else if (strcmp(line, "defaults") == 0) {
        if(arming_state()==ARM_ARMED){cli_write_str("refused: armed\r\n");return;}
        config_defaults();
        cli_write_str("defaults restored\r\n");
    } else if (strcmp(line, "arm") == 0) {
        if (arming_try_arm()) {
            cli_write_str("armed\r\n");
        } else {
            cli_write_str("arm refused (gyro unhealthy or failsafe)\r\n");
        }
    } else if (strcmp(line, "disarm") == 0) {
        arming_disarm();
        cli_write_str("disarmed\r\n");
    } else if(cmd_sensor_command(line)) {
        /* sensor handler performed a bounded read or nonblocking action */
    } else if(strncmp(line,"receiver_uart ",14)==0){
        unsigned uart=0;char extra;
        if(arming_state()!=ARM_ARMED && !bench_motor_active() && sscanf(line+14,"%u %c",&uart,&extra)==1 && board_select_rx_uart(uart)){
            failsafe_reset_rx_link();rx_init();cli_write_str("receiver UART changed (until reboot)\r\n");
        }else cli_write_str("receiver UART refused\r\n");
    } else if(strncmp(line,"motor_pulse ",12)==0){
        unsigned motor,percent;
        if(bench_parse_pulse(line+12,&motor,&percent) && bench_motor_pulse(motor,percent))
            cli_write_str("motor pulse accepted (one second maximum)\r\n");
        else cli_write_str("motor pulse refused\r\n");
    } else if(strncmp(line,"motor_test ",11)==0){
        unsigned motor=99;
        if(bench_parse_motor(line+11,&motor) && bench_motor_test(motor))cli_write_str("motor test accepted (one second maximum)\r\n");
        else cli_write_str("motor test refused\r\n");
    } else if(strcmp(line,"motor_seq")==0){
        if(bench_motor_seq_start())cli_write_str("sequence running: RR FR RL FL, 1s each - watch spin direction\r\n");
        else cli_write_str("motor_seq refused (disarmed, USB CDC and healthy DShot required)\r\n");
    } else if(strcmp(line,"dshot")==0){
        char buf[48];
        snprintf(buf,sizeof(buf),"dshot: %u kbps\r\n",dshot_speed_kbps());
        cli_write_str(buf);
    } else if(strncmp(line,"dshot ",6)==0){
        unsigned kbps=0;char extra;
        if(sscanf(line+6,"%u %c",&kbps,&extra)==1 && dshot_set_speed_kbps(kbps)){
            char buf[48];
            snprintf(buf,sizeof(buf),"dshot: switched to %u kbps\r\n",dshot_speed_kbps());
            cli_write_str(buf);
        }else cli_write_str("dshot speed refused (300 or 600, disarmed, bench stopped only)\r\n");
    } else if (strcmp(line, "reboot") == 0) {
        cli_write_str("reboot...\r\n");
        g_reboot_req = true;
    } else {
        cli_write_str("unknown — try help\r\n");
    }
}

void cli_init(void)
{
    g_len = 0;
    g_discard_line = false;
    g_reboot_req = false;
    cli_write_str("\r\n" BOBFLIGHT_PRODUCT_NAME " " BOBFLIGHT_VERSION_STRING " ready\r\n");
}

void cli_poll(void)
{
    /* Keep TinyUSB / CDC alive on MCU (bg_cli_poll path). Host HAL no-op. */
    hal_usb_cdc_poll();
    power_poll();
    uint8_t buf[32];
    size_t n = hal_usb_cdc_read(buf, sizeof(buf));
    for (size_t i = 0; i < n; i++) {
        char c = (char)buf[i];
        if (c == '\n' || c == '\r') {
            g_line[g_len] = '\0';
            if(g_discard_line)cli_write_str("invalid CLI line refused\r\n");
            else handle_line(g_line);
            g_len = 0;
            g_discard_line = false;
        } else if (g_discard_line) {
            /* Discard the WHOLE invalid line, never execute its suffix. */
        } else if (c == '\0') {
            g_discard_line = true;
        } else if (g_len + 1 < sizeof(g_line)) {
            g_line[g_len++] = c;
        } else {
            g_discard_line = true;
        }
    }
}
