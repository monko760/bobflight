/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0.
 * Private implementation included by cli.c after cli_write_str. No streaming,
 * sleeping, or persistent flash writes. The response marker bounds each query.
 */
#ifndef BOBFLIGHT_SENSOR_CLI_H
#define BOBFLIGHT_SENSOR_CLI_H
#include <math.h>
#include "drivers/calibration_policy.h"
static void cmd_sensors(bool details)
{
    char buf[1100];
    gyro_calibration_info_t c;
    gyro_calibration_tick();
    gyro_calibration_touch();
    gyro_calibration_info(&c);
    const gyro_diagnostics_t *d=gyro_diagnostics();
    const float *g=gyro_latest_dps(), *a=gyro_accel_g(), *r=attitude_degrees();
    uint32_t age=d->sample_seq ? (uint32_t)(hal_millis()-d->sample_ms) : UINT32_MAX;
    int n=snprintf(buf,sizeof(buf),
        "sensors_version: 1\r\nsample_seq: %lu\r\nsample_ms: %lu\r\nsensor_age_ms: %lu\r\n"
        "gyro_ok: %s\r\ngyro_calibrated: %s\r\naccel_calibrated: %s\r\n"
        "gyro_dps: %.3f %.3f %.3f\r\naccel_g: %.4f %.4f %.4f\r\n"
        "accel_raw_g: %.4f %.4f %.4f\r\nattitude_deg: %.2f %.2f %.2f\r\nattitude_ready: %s\r\n"
        "arm: %s\r\nmotor_active: %s\r\ncal_state: %s\r\ncal_samples: %u\r\ncal_required: %u\r\n"
        "cal_faces: %u\r\ncal_face: %d\r\ncal_reason: %s\r\ncal_manual: %s\r\n"
        "calibration_storage: ram-only\r\nsensor_config_ok: %s\r\n",
        (unsigned long)d->sample_seq,(unsigned long)d->sample_ms,(unsigned long)age,
        gyro_is_healthy()?"yes":"no",gyro_calibrated()?"yes":"no",c.accel_valid?"yes":"no",
        (double)g[0],(double)g[1],(double)g[2],(double)a[0],(double)a[1],(double)a[2],
        (double)d->raw_acc_g[0],(double)d->raw_acc_g[1],(double)d->raw_acc_g[2],
        (double)r[0],(double)r[1],(double)r[2],attitude_ready()?"yes":"no",
        arming_state()==ARM_ARMED?"armed":"disarmed",bench_motor_active()?"yes":"no",
        c.state,c.samples,c.required,c.faces,c.face,c.reason,
        gyro_manual_calibration_active()?"yes":"no",d->config_ok?"yes":"no");
    if(n<0 || (size_t)n>=sizeof(buf)){cli_write_str("sensor response failed: overflow\r\n");return;}
    cli_write_str(buf);
    cli_write_str(BOBFLIGHT_ACCEL_BENCH_RELAXED?"cal_bench_relaxed: yes\r\n":"cal_bench_relaxed: no\r\n");
    n=snprintf(buf,sizeof(buf),"cal_apply_detail: %s\r\n",c.apply_detail?c.apply_detail:"");
    if(n<0 || (size_t)n>=sizeof(buf)){cli_write_str("sensor response failed: overflow\r\n");return;}
    cli_write_str(buf);
    if(details) {
        n=snprintf(buf,sizeof(buf),"sensor_chip: %s\r\nmpu_gyro_config: 0x%02x\r\nmpu_accel_config: 0x%02x\r\n"
            "gyro_bias: %.5f %.5f %.5f\r\naccel_bias: %.6f %.6f %.6f\r\naccel_scale: %.6f %.6f %.6f\r\n",
            d->chip,(unsigned)d->gyro_config,(unsigned)d->accel_config,
            (double)c.gyro_bias[0],(double)c.gyro_bias[1],(double)c.gyro_bias[2],
            (double)c.accel_bias[0],(double)c.accel_bias[1],(double)c.accel_bias[2],
            (double)c.accel_scale[0],(double)c.accel_scale[1],(double)c.accel_scale[2]);
        if(n<0 || (size_t)n>=sizeof(buf)){cli_write_str("sensor response failed: overflow\r\n");return;}
        cli_write_str(buf);
        cli_write_str("cal_diagnostics_version: 1\r\n");
        for(unsigned face=0;face<6;face++) {
            const float *v=c.face_mean[face];
            if(!(c.faces&(1u<<face)))n=snprintf(buf,sizeof(buf),"cal_raw_face_%u: uncaptured\r\n",face);
            else if(!isfinite(v[0]) || !isfinite(v[1]) || !isfinite(v[2]))n=snprintf(buf,sizeof(buf),"cal_raw_face_%u: unavailable\r\n",face);
            else n=snprintf(buf,sizeof(buf),"cal_raw_face_%u: %.6f %.6f %.6f\r\n",face,(double)v[0],(double)v[1],(double)v[2]);
            if(n<0 || (size_t)n>=sizeof(buf)){cli_write_str("sensor response failed: overflow\r\n");return;}
            cli_write_str(buf);
        }
        cli_write_str(c.candidate_valid?"cal_candidate_valid: yes\r\n":"cal_candidate_valid: no\r\n");
        if(c.candidate_valid) {
            n=snprintf(buf,sizeof(buf),"cal_candidate_bias: %.6f %.6f %.6f\r\ncal_candidate_scale: %.6f %.6f %.6f\r\n",
                (double)c.candidate_bias[0],(double)c.candidate_bias[1],(double)c.candidate_bias[2],
                (double)c.candidate_scale[0],(double)c.candidate_scale[1],(double)c.candidate_scale[2]);
            if(n<0 || (size_t)n>=sizeof(buf)){cli_write_str("sensor response failed: overflow\r\n");return;}
            cli_write_str(buf);
        }
    }
    cli_write_str(details?"calibration_end: 1\r\n":"sensors_end: 1\r\n");
}
static bool calibration_allowed(void)
{
    const gyro_diagnostics_t *d=gyro_diagnostics();
    return arming_state()!=ARM_ARMED && !bench_motor_active() &&
           hal_usb_cdc_connected() && gyro_is_healthy() && d->config_ok &&
           d->sample_seq && (uint32_t)(hal_millis()-d->sample_ms)<=100u;
}
static bool cmd_sensor_command(const char *line)
{
    if(strcmp(line,"sensors")==0 || strcmp(line,"calibration")==0) {
        cmd_sensors(strcmp(line,"calibration")==0);
    } else if(strcmp(line,"calibration_cancel")==0 || strcmp(line,"calibrate_accel cancel")==0) {
        gyro_cancel_manual_calibration();cli_write_str("calibration cancelled; applied coefficients retained\r\n");
    } else if(strcmp(line,"calibrate_gyro")==0) {
        if(calibration_allowed() && gyro_start_manual_calibration())
            cli_write_str("calibration started: gyro; keep still; RAM only until reboot\r\n");
        else cli_write_str("calibration refused: require fresh verified IMU, disarmed, motors stopped, USB and no conflicting session\r\n");
    } else if(strncmp(line,"calibrate_accel ",16)==0) {
        const char *arg=line+16;bool ok=false;
        if(calibration_allowed()) {
            if(strcmp(arg,"start")==0)ok=gyro_start_accel_calibration();
            else if(strcmp(arg,"apply")==0)ok=gyro_apply_accel_calibration();
            else {
                const char *faces[]={"+x","-x","+y","-y","+z","-z"};
                for(unsigned i=0;i<6;i++)if(strcmp(arg,faces[i])==0)ok=gyro_capture_accel_face(i);
            }
        }
        cli_write_str(ok?"accelerometer calibration request accepted (RAM only)\r\n":
            "calibration refused: invalid request, unsafe/stale IMU, wrong session, incomplete or implausible faces\r\n");
    } else return false;
    return true;
}
#endif
