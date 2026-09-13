/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_STORAGE_CLI_H
#define BOBFLIGHT_STORAGE_CLI_H
#include "drivers/persist.h"
#include "drivers/gyro.h"
#include "board/pins_generated.h"
#include <stdarg.h>

/* These commands report stored configuration, never telemetry or arm state as settings. */
static void cmd_storage(void)
{
    char buf[600];
    unsigned flight_enabled=0;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
    flight_enabled=1;
#endif
    int n = snprintf(buf, sizeof(buf),
        "storage_api: 1\r\nbackend: %s\r\nschema: 2\r\nstate: %s\r\n"
        "dirty: %u\r\ngeneration: %lu\r\nlast_error: %s\r\n"
        "scope: pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection,accel_calibration\r\n"
        "armed: %u\r\nbench_active: %u\r\ncalibration_active: %u\r\nflight_enabled: %u\r\nstorage_end: 1\r\n",
        persist_backend(), persist_state(), persist_dirty() ? 1u : 0u,
        (unsigned long)persist_generation(), persist_last_error(),
        arming_state() == ARM_ARMED ? 1u : 0u, bench_motor_active() ? 1u : 0u, gyro_manual_calibration_active()?1u:0u,flight_enabled);
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

static void cmd_config_export(bool full)
{
    static const struct { const char *name; float value; } defaults[] = {
        {"rate_max_roll", 800.f}, {"rate_max_pitch", 800.f}, {"rate_max_yaw", 800.f},
        {"rate_expo", .30f}, {"pid_roll_p", .002f}, {"pid_roll_i", .001f},
        {"pid_roll_d", .00005f}, {"pid_pitch_p", .002f}, {"pid_pitch_i", .001f},
        {"pid_pitch_d", .00005f}, {"pid_yaw_p", .002f}, {"pid_yaw_i", .001f}
    };
    char out[1800]; size_t used = 0;
    const board_t *b = board_get();
    bool ok = export_append(out, sizeof(out), &used,
        "# bobflight_config: 1\r\n# schema: 2\r\n# board: %s\r\n"
        "# firmware: %s\r\n# kind: %s\r\n# mode_count: %u\r\n"
        "# scope: pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection,accel_calibration\r\n"
        "# excludes: gyro_calibration,power,dshot\r\n",
        b ? b->board_id : "unknown", BOBFLIGHT_VERSION_STRING, full ? "dump" : "diff", (unsigned)MODE_COUNT);
    gyro_calibration_info_t cal;gyro_calibration_info(&cal);
    if(ok)ok=export_append(out,sizeof(out),&used,
        "# accel_calibrated: %s\r\n# accel_bias: %.9g %.9g %.9g\r\n# accel_scale: %.9g %.9g %.9g\r\n"
        "# accel_storage: %s\r\n# calibration_restore: metadata-only-recalibrate-if-flash-lost\r\n",
        cal.accel_valid?"yes":"no",(double)cal.accel_bias[0],(double)cal.accel_bias[1],(double)cal.accel_bias[2],
        (double)cal.accel_scale[0],(double)cal.accel_scale[1],(double)cal.accel_scale[2],persist_accel_storage());
    for (size_t i = 0; ok && i < sizeof(defaults) / sizeof(defaults[0]); ++i) {
        float value;
        ok = config_get_key(defaults[i].name, &value);
        if (ok && (full || value != defaults[i].value))
            ok = export_append(out, sizeof(out), &used, "set %s %.9g\r\n", defaults[i].name, (double)value);
    }
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
        unsigned min_default = i == MODE_ARM ? 1751u : 900u;
        if (full || m->enabled != (i < 2) || m->aux_channel != (i == 0 ? 1 : 2) || m->min_us != min_default || m->max_us != 2100)
            ok = export_append(out, sizeof(out), &used, "mode_range %s %u %u %u %u\r\n",
                mode_names[i], m->enabled ? 1u : 0u,
                (unsigned)m->aux_channel, (unsigned)m->min_us, (unsigned)m->max_us);
    }
    if (ok) ok = export_append(out, sizeof(out), &used, "# config_end: 1\r\n");
    cli_write_str(ok ? out : "config export failed: invalid_or_oversize\r\n");
}
#endif
