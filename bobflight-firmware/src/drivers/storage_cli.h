/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_STORAGE_CLI_H
#define BOBFLIGHT_STORAGE_CLI_H
#include "drivers/persist.h"
#include "drivers/config_store.h"
#include "flight/config.h"
#include "drivers/gyro.h"
#include "drivers/power.h"
#include "drivers/dshot.h"
#include "board/pins_generated.h"
#include "sched/loop_rate_setting.h"
#include <stdarg.h>

/* These commands report stored configuration, never telemetry or arm state as settings. */
static void cmd_storage(void)
{
    char buf[1000];
    unsigned flight_enabled=0;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    flight_enabled=1;
#endif
    int n = snprintf(buf, sizeof(buf),
        "storage_api: 1\r\nbackend: %s\r\nschema: %u\r\nstate: %s\r\n"
        "dirty: %u\r\ngeneration: %lu\r\nlast_error: %s\r\n"
        "scope: pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection,accel_calibration,power,dshot,min_throttle,airmode,gyro_lpf_hz,dterm_lpf_hz,pid_yaw_d,loop_rate_hz,gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz,rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles,motor_direction,align_board_roll,align_board_pitch,align_board_yaw,actual_rates\r\n"
        "armed: %u\r\nbench_active: %u\r\ncalibration_active: %u\r\nflight_enabled: %u\r\n"
        /* Additive (D1): after every field existing parsers read, before the end marker. */
        "accel_cal_saved: %s\r\n"
        /* Additive (N3): schema of the record in flash (13 = migrated on load, rewritten as 14 on next save). */
        "stored_schema: %s\r\nstorage_end: 1\r\n",
        persist_backend(), (unsigned)CONFIG_STORE_SCHEMA, persist_state(), persist_dirty() ? 1u : 0u,
        (unsigned long)persist_generation(), persist_last_error(),
        arming_state() == ARM_ARMED ? 1u : 0u, bench_motor_active() ? 1u : 0u, gyro_manual_calibration_active()?1u:0u,flight_enabled,
        persist_accel_calibration_saved() ? "yes" : "no", persist_stored_schema());
    if (n < 0 || (size_t)n >= sizeof(buf)) cli_write_str("storage failed: overflow\r\n");
    else cli_write_str(buf);
}

static void cmd_save_config(void)
{
    char buf[160];
    if (persist_save())
        snprintf(buf, sizeof(buf), "saved: %s verified\r\n", persist_backend());
    else
        snprintf(buf, sizeof(buf), "save failed: %s\r\n", persist_last_error());
    cli_write_str(buf);
}

/* Build the entire bounded report first. No partial export or truncated commands. */
static bool export_append(char *out, size_t cap, size_t *used, const char *format, ...)
{
    if (*used >= cap) return false;
    va_list ap;
    va_start(ap, format);
    int n = vsnprintf(out + *used, cap - *used, format, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= cap - *used) return false;
    *used += (size_t)n;
    return true;
}

/* Export ORDER only (frozen: notch cutoff before centre so a pasted export
 * replays onto defaults). Default VALUES come from config_get_default_key(),
 * the single defaults source in flight/config.c (N3). */
static const char *const g_export_keys[] = {
    "rate_max_roll", "rate_max_pitch", "rate_max_yaw",
    "pid_roll_p", "pid_roll_i", "pid_roll_d",
    "pid_pitch_p", "pid_pitch_i", "pid_pitch_d",
    "pid_yaw_p", "pid_yaw_i", "pid_yaw_d",
    "min_throttle", "airmode", "gyro_lpf_hz", "dterm_lpf_hz",
    "gyro_notch1_cutoff_hz", "gyro_notch1_hz",
    "gyro_notch2_cutoff_hz", "gyro_notch2_hz",
    "rpm_filter_harmonics", "rpm_filter_min_hz", "rpm_filter_q_x100", "motor_poles",
    "align_board_roll", "align_board_pitch", "align_board_yaw",
    "rate_center_roll", "rate_center_pitch", "rate_center_yaw",
    "rate_expo_roll", "rate_expo_pitch", "rate_expo_yaw"
};

static void cmd_config_export(bool full)
{
    /* Configurator CONFIG_EXPORT_MAX_BYTES: 3072 (unchanged for schema 14: no new exported keys).
     * Worst-case calibrated dump remains bounded and is tested in host_storage_cli. */
    char out[3072]; size_t used = 0;
    const board_t *b = board_get();
    bool ok = export_append(out, sizeof(out), &used,
        "# bobflight_config: 1\r\n# schema: %u\r\n# board: %s\r\n"
        "# firmware: %s\r\n# kind: %s\r\n# mode_count: %u\r\n"
        "# scope: pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection,accel_calibration,power,dshot,min_throttle,airmode,gyro_lpf_hz,dterm_lpf_hz,pid_yaw_d,loop_rate_hz,gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz,rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles,motor_direction,align_board_roll,align_board_pitch,align_board_yaw,actual_rates\r\n"
        "# excludes: gyro_calibration\r\n",
        (unsigned)CONFIG_STORE_SCHEMA, b ? b->board_id : "unknown", BOBFLIGHT_VERSION_STRING, full ? "dump" : "diff", (unsigned)MODE_COUNT);
    gyro_calibration_info_t cal;gyro_calibration_info(&cal);
    if(ok)ok=export_append(out,sizeof(out),&used,
        "# accel_calibrated: %s\r\n# accel_bias: %.9g %.9g %.9g\r\n# accel_scale: %.9g %.9g %.9g\r\n"
        "# accel_storage: %s\r\n# calibration_restore: metadata-only-recalibrate-if-flash-lost\r\n",
        cal.accel_valid?"yes":"no",(double)cal.accel_bias[0],(double)cal.accel_bias[1],(double)cal.accel_bias[2],
        (double)cal.accel_scale[0],(double)cal.accel_scale[1],(double)cal.accel_scale[2],persist_accel_storage());
    const power_config_t *pc=power_config();
    if(ok)ok=export_append(out,sizeof(out),&used,"power_config %.9g %.9g %.9g %u %.9g %.9g %u\r\n",
      (double)pc->voltage_scale,(double)pc->current_mv_per_amp,(double)pc->current_offset_mv,pc->cells,(double)pc->warning_cell_v,(double)pc->critical_cell_v,pc->capacity_mah);
    if(ok)ok=export_append(out,sizeof(out),&used,"dshot %u\r\n",dshot_speed_kbps());
    for (size_t i = 0; ok && i < sizeof(g_export_keys) / sizeof(g_export_keys[0]); ++i) {
        float value, def;
        ok = config_get_key(g_export_keys[i], &value) && config_get_default_key(g_export_keys[i], &def);
        if (ok && (full || value != def))
            ok = export_append(out, sizeof(out), &used, "set %s %.9g\r\n", g_export_keys[i], (double)value);
    }
    /* Schema 10 motor_direction token (default props-out). */
    if (ok && (full || config_motor_direction() != MOTOR_DIRECTION_PROPS_OUT))
        ok = export_append(out, sizeof(out), &used, "set motor_direction %s\r\n",
                           config_motor_direction_name(config_motor_direction()));
    if (ok && (full || loop_rate_setting_get() != loop_rate_setting_default_hz()))
        ok = export_append(out, sizeof(out), &used, "set loop_rate_hz %lu\r\n", (unsigned long)loop_rate_setting_get());
    if (ok && b && b->rx_uart > 0 && (full || b->rx_uart != BOARD_GENERATED_RX_UART))
        ok = export_append(out, sizeof(out), &used, "receiver_uart %u\r\n", b->rx_uart);
    if (ok && (full || strcmp(crsf_map(), "AETR") != 0))
        ok = export_append(out, sizeof(out), &used, "receiver_map %s\r\n", crsf_map());
    if (ok && (full || control_mode_get() != CONTROL_MODE_ANGLE))
        ok = export_append(out, sizeof(out), &used, "control_mode %s\r\n", control_mode_name());
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
    if (ok && (full || strcmp(control_source_name(), "manual")))
        ok = export_append(out, sizeof(out), &used, "control_source %s\r\n", control_source_name());
#endif
    static const char *mode_names[] = {"ARM", "ANGLE", "ACRO", "HORIZON"};
    for (unsigned i = 0; ok && i < MODE_COUNT; ++i) {
        const mode_config_t *m = mode_range_get((mode_id_t)i);
        if (!m) { ok = false; break; }
        const mode_config_t *d = mode_range_default((mode_id_t)i);
        if (!d) { ok = false; break; }
        if (full || m->enabled != d->enabled || m->aux_channel != d->aux_channel || m->min_us != d->min_us || m->max_us != d->max_us)
            ok = export_append(out, sizeof(out), &used, "mode_range %s %u %u %u %u\r\n",
                mode_names[i], m->enabled ? 1u : 0u,
                (unsigned)m->aux_channel, (unsigned)m->min_us, (unsigned)m->max_us);
    }
    if (ok) ok = export_append(out, sizeof(out), &used, "# config_end: 1\r\n");
    cli_write_str(ok ? out : "config export failed: invalid_or_oversize\r\n");
}
#endif
