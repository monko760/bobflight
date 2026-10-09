/* SPDX-License-Identifier: Apache-2.0f */
#include "drivers/bmp280.h"
#include <math.h>
#include <string.h>

static void bmp280_fail(bmp280_t *ctx, const char *reason, uint32_t now) {
    if (!ctx) return;
    if (ctx->io.cancel) {
        ctx->io.cancel();
    }
    ctx->state = BMP280_STATE_FAILED;
    ctx->reason = reason;
    ctx->fail_time_ms = now;
    ctx->fresh = false;
    ctx->valid = false;
    ctx->pressure_valid = false;
    ctx->temp_valid = false;
    ctx->alt_valid = false;
}

static bool bmp280_validate_trim(const uint8_t *buf, const bmp280_trim_t *trim) {
    bool all_zero = true;
    bool all_ff = true;
    for (size_t i = 0; i < 24; i++) {
        if (buf[i] != 0x00) all_zero = false;
        if (buf[i] != 0xFF) all_ff = false;
    }
    if (all_zero || all_ff) return false;
    if (trim->dig_P1 == 0 || trim->dig_T1 == 0 || trim->dig_P1 == UINT16_MAX || trim->dig_T1 == UINT16_MAX) return false;
    return true;
}

static bool bmp280_compensate(const bmp280_trim_t *trim, uint32_t raw_T, uint32_t raw_P, float *out_temp, float *out_press) {
    if (!trim || !out_temp || !out_press) return false;

    if (raw_T > 0xfffff || raw_P > 0xfffff || raw_T == 0x80000 || raw_P == 0x80000) return false;

    /* Temperature compensation using float precision float algebra */
    float adc_T = (float)raw_T;
    float var1_t = (adc_T / 16384.0f - (float)trim->dig_T1 / 1024.0f) * (float)trim->dig_T2;
    float var2_t = ((adc_T / 131072.0f - (float)trim->dig_T1 / 8192.0f) *
                    (adc_T / 131072.0f - (float)trim->dig_T1 / 8192.0f)) * (float)trim->dig_T3;
    float t_fine = var1_t + var2_t;
    float temp = t_fine / 5120.0f;

    /* Pressure compensation using float precision float algebra */
    float var1_p = (t_fine / 2.0f) - 64000.0f;
    float var2_p = var1_p * var1_p * (float)trim->dig_P6 / 32768.0f;
    var2_p = var2_p + var1_p * (float)trim->dig_P5 * 2.0f;
    var2_p = (var2_p / 4.0f) + ((float)trim->dig_P4 * 65536.0f);
    var1_p = ((float)trim->dig_P3 * var1_p * var1_p / 524288.0f + (float)trim->dig_P2 * var1_p) / 524288.0f;
    var1_p = (1.0f + var1_p / 32768.0f) * (float)trim->dig_P1;

    if (var1_p == 0.0f) return false;

    float p = 1048576.0f - (float)raw_P;
    p = (p - (var2_p / 4096.0f)) * 6250.0f / var1_p;
    var1_p = (float)trim->dig_P9 * p * p / 2147483648.0f;
    var2_p = p * (float)trim->dig_P8 / 32768.0f;
    p = p + (var1_p + var2_p + (float)trim->dig_P7) / 16.0f;

    if (isnan(temp) || isinf(temp) || isnan(p) || isinf(p)) return false;
    if (temp < -40.0f || temp > 85.0f) return false;
    if (p < 30000.0f || p > 110000.0f) return false;

    *out_temp = (float)temp;
    *out_press = (float)p;
    return true;
}

static bool bmp280_start_probe(bmp280_t *ctx, uint8_t probe_idx, uint32_t now) {
    ctx->probe_idx = probe_idx;
    ctx->address = (probe_idx == 0) ? BMP280_I2C_ADDR_PRIMARY : BMP280_I2C_ADDR_SECONDARY;
    ctx->reason = (probe_idx == 0) ? "probing_0x76" : "probing_0x77";
    ctx->step_start_ms = now;
    return ctx->io.begin(ctx->address, BMP280_REG_CHIP_ID, ctx->io_buf, 1, true, now);
}

bool bmp280_init(bmp280_t *ctx, const bmp280_io_t *io, uint32_t now) {
    if (!ctx || !io || !io->begin || !io->poll || !io->cancel) {
        return false;
    }
    bmp280_io_t saved_io = *io;
    memset(ctx, 0, sizeof(*ctx));
    ctx->io = saved_io;
    ctx->state = BMP280_STATE_PROBE;

    if (!bmp280_start_probe(ctx, 0, now)) {
        if (!bmp280_start_probe(ctx, 1, now)) {
            bmp280_fail(ctx, "probe_start_failed", now);
            return false;
        }
    }
    return true;
}

void bmp280_poll(bmp280_t *ctx, uint32_t now) {
    if (!ctx) return;

    switch (ctx->state) {
    case BMP280_STATE_UNINIT:
        break;

    case BMP280_STATE_PROBE: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->step_start_ms > 50) {
                if (ctx->probe_idx == 0 && (ctx->io.cancel(), bmp280_start_probe(ctx, 1, now))) {
                    return;
                }
                bmp280_fail(ctx, "probe_timeout", now);
            }
            return;
        }
        if (res < 0) {
            if (ctx->probe_idx == 0 && (ctx->io.cancel(), bmp280_start_probe(ctx, 1, now))) {
                return;
            }
            bmp280_fail(ctx, "probe_nack", now);
            return;
        }
        if (res == 1) {
            if (ctx->io_buf[0] != BMP280_CHIP_ID) {
                if (ctx->probe_idx == 0 && (ctx->io.cancel(), bmp280_start_probe(ctx, 1, now))) {
                    return;
                }
                bmp280_fail(ctx, "wrong_chip_id", now);
                return;
            }
            ctx->state = BMP280_STATE_CHECK_NVM;
            ctx->reason = "checking_nvm";
            ctx->step_start_ms = now;
            if (!ctx->io.begin(ctx->address, BMP280_REG_STATUS, ctx->io_buf, 1, true, now)) {
                bmp280_fail(ctx, "nvm_check_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_CHECK_NVM: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->step_start_ms > 50) {
                bmp280_fail(ctx, "nvm_check_timeout", now);
            }
            return;
        }
        if (res < 0) {
            bmp280_fail(ctx, "nvm_check_nack", now);
            return;
        }
        if (res == 1) {
            uint8_t status = ctx->io_buf[0];
            if (status & 0x01) { /* Bit 0 im_update is 1 */
                if (now - ctx->step_start_ms > 50) {
                    bmp280_fail(ctx, "nvm_update_timeout", now);
                    return;
                }
                if (!ctx->io.begin(ctx->address, BMP280_REG_STATUS, ctx->io_buf, 1, true, now)) {
                    bmp280_fail(ctx, "nvm_check_start_failed", now);
                }
                return;
            }
            ctx->state = BMP280_STATE_READ_TRIM;
            ctx->reason = "reading_trim";
            ctx->step_start_ms = now;
            if (!ctx->io.begin(ctx->address, BMP280_REG_TRIM_START, ctx->io_buf, 24, true, now)) {
                bmp280_fail(ctx, "read_trim_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_READ_TRIM: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->step_start_ms > 50) {
                bmp280_fail(ctx, "read_trim_timeout", now);
            }
            return;
        }
        if (res < 0) {
            bmp280_fail(ctx, "read_trim_nack", now);
            return;
        }
        if (res == 1) {
            ctx->trim.dig_T1 = (uint16_t)ctx->io_buf[0] | ((uint16_t)ctx->io_buf[1] << 8);
            ctx->trim.dig_T2 = (int16_t)(ctx->io_buf[2] | (ctx->io_buf[3] << 8));
            ctx->trim.dig_T3 = (int16_t)(ctx->io_buf[4] | (ctx->io_buf[5] << 8));
            ctx->trim.dig_P1 = (uint16_t)ctx->io_buf[6] | ((uint16_t)ctx->io_buf[7] << 8);
            ctx->trim.dig_P2 = (int16_t)(ctx->io_buf[8] | (ctx->io_buf[9] << 8));
            ctx->trim.dig_P3 = (int16_t)(ctx->io_buf[10] | (ctx->io_buf[11] << 8));
            ctx->trim.dig_P4 = (int16_t)(ctx->io_buf[12] | (ctx->io_buf[13] << 8));
            ctx->trim.dig_P5 = (int16_t)(ctx->io_buf[14] | (ctx->io_buf[15] << 8));
            ctx->trim.dig_P6 = (int16_t)(ctx->io_buf[16] | (ctx->io_buf[17] << 8));
            ctx->trim.dig_P7 = (int16_t)(ctx->io_buf[18] | (ctx->io_buf[19] << 8));
            ctx->trim.dig_P8 = (int16_t)(ctx->io_buf[20] | (ctx->io_buf[21] << 8));
            ctx->trim.dig_P9 = (int16_t)(ctx->io_buf[22] | (ctx->io_buf[23] << 8));

            if (!bmp280_validate_trim(ctx->io_buf, &ctx->trim)) {
                bmp280_fail(ctx, "bad_trim", now);
                return;
            }

            ctx->state = BMP280_STATE_TRIGGER_CONV;
            ctx->reason = "trigger_conv";
            ctx->step_start_ms = now;
            ctx->io_buf[0] = BMP280_CTRL_MEAS_FORCED_X1T_X4P;
            if (!ctx->io.begin(ctx->address, BMP280_REG_CTRL_MEAS, ctx->io_buf, 1, false, now)) {
                bmp280_fail(ctx, "trigger_conv_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_TRIGGER_CONV: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->step_start_ms > 50) {
                bmp280_fail(ctx, "trigger_conv_timeout", now);
            }
            return;
        }
        if (res < 0) {
            bmp280_fail(ctx, "trigger_conv_nack", now);
            return;
        }
        if (res == 1) {
            ctx->conv_start_ms = now;
            ctx->state = BMP280_STATE_WAIT_CONV;
            ctx->reason = "converting";
        }
        break;
    }

    case BMP280_STATE_WAIT_CONV: {
        if (now - ctx->conv_start_ms >= 15) {
            ctx->state = BMP280_STATE_POLL_STATUS;
            ctx->reason = "polling_status";
            ctx->step_start_ms = now;
            if (!ctx->io.begin(ctx->address, BMP280_REG_STATUS, ctx->io_buf, 1, true, now)) {
                bmp280_fail(ctx, "status_poll_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_POLL_STATUS: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->conv_start_ms > 50) {
                bmp280_fail(ctx, "measuring_timeout", now);
            }
            return;
        }
        if (res < 0) {
            bmp280_fail(ctx, "status_poll_nack", now);
            return;
        }
        if (res == 1) {
            uint8_t status = ctx->io_buf[0];
            if (status & 0x08) { /* Bit 3 measuring is 1 */
                if (now - ctx->conv_start_ms > 50) {
                    bmp280_fail(ctx, "measuring_timeout", now);
                    return;
                }
                if (!ctx->io.begin(ctx->address, BMP280_REG_STATUS, ctx->io_buf, 1, true, now)) {
                    bmp280_fail(ctx, "status_poll_start_failed", now);
                }
                return;
            }
            ctx->state = BMP280_STATE_READ_DATA;
            ctx->reason = "reading_data";
            ctx->step_start_ms = now;
            if (!ctx->io.begin(ctx->address, BMP280_REG_DATA_START, ctx->io_buf, 6, true, now)) {
                bmp280_fail(ctx, "read_data_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_READ_DATA: {
        int res = ctx->io.poll(now);
        if (res == 0) {
            if (now - ctx->conv_start_ms > 50) {
                bmp280_fail(ctx, "read_data_timeout", now);
            }
            return;
        }
        if (res < 0) {
            bmp280_fail(ctx, "read_data_nack", now);
            return;
        }
        if (res == 1) {
            uint32_t raw_P = ((uint32_t)ctx->io_buf[0] << 12) | ((uint32_t)ctx->io_buf[1] << 4) | ((uint32_t)ctx->io_buf[2] >> 4);
            uint32_t raw_T = ((uint32_t)ctx->io_buf[3] << 12) | ((uint32_t)ctx->io_buf[4] << 4) | ((uint32_t)ctx->io_buf[5] >> 4);

            float temp = 0.0f, press = 0.0f;
            if (!bmp280_compensate(&ctx->trim, raw_T, raw_P, &temp, &press)) {
                ctx->fresh = false;
                ctx->valid = false;
                ctx->pressure_valid = false;
                ctx->temp_valid = false;
                ctx->alt_valid = false;
                ctx->reason = "invalid_sample";
                ctx->state = BMP280_STATE_READY;
                return;
            }

            ctx->temp = temp;
            ctx->pressure = press;
            ctx->sample_seq++;
            ctx->sampletime = now;
            ctx->fresh = true;
            ctx->pressure_valid = true;
            ctx->temp_valid = true;
            ctx->valid = true;
            ctx->reason = "ok";
            ctx->last_conv_ms = now;

            if (!ctx->reference_valid) {
                ctx->p_acc += press;
                ctx->ref_count++;
                if (ctx->ref_count >= 32) {
                    ctx->reference = (float)(ctx->p_acc / 32.0f);
                    ctx->reference_valid = true;
                }
            }

            if (ctx->reference_valid) {
                ctx->relativealt = 100.0f * 44330.0f * (1.0f - powf(ctx->pressure / ctx->reference, 0.19029495f));
                ctx->alt_valid = true;
            }

            ctx->state = BMP280_STATE_READY;
        }
        break;
    }

    case BMP280_STATE_READY: {
        if (ctx->fresh && (now - ctx->sampletime > 250)) {
            ctx->fresh = false;
            ctx->valid = false;
            ctx->pressure_valid = false;
            ctx->temp_valid = false;
            ctx->alt_valid = false;
        }

        if (now - ctx->conv_start_ms >= 50) {
            ctx->state = BMP280_STATE_TRIGGER_CONV;
            ctx->reason = "trigger_conv";
            ctx->step_start_ms = now;
            ctx->io_buf[0] = BMP280_CTRL_MEAS_FORCED_X1T_X4P;
            if (!ctx->io.begin(ctx->address, BMP280_REG_CTRL_MEAS, ctx->io_buf, 1, false, now)) {
                bmp280_fail(ctx, "trigger_conv_start_failed", now);
            }
        }
        break;
    }

    case BMP280_STATE_FAILED: {
        ctx->fresh = false;
        ctx->valid = false;
        ctx->pressure_valid = false;
        ctx->temp_valid = false;
        ctx->alt_valid = false;

        if ((now - ctx->fail_time_ms >= 1000)) {
            bmp280_init(ctx, &ctx->io, now);
        }
        break;
    }
    }
}

bool bmp280_snapshot(bmp280_t *ctx, uint32_t now, bmp280_snapshot_t *out) {
    if (!ctx) return false;

    bool is_fresh = ctx->fresh && (ctx->sample_seq > 0) &&
                   (now - ctx->sampletime <= 250);

    if (out) {
        out->state = ctx->state;
        out->reason = ctx->reason;
        out->address = ctx->address;
        out->sample_seq = ctx->sample_seq;
        out->sampletime = ctx->sampletime;
        out->age_ms=ctx->sample_seq?(uint32_t)(now-ctx->sampletime):UINT32_MAX;
        out->pressure = ctx->pressure;
        out->temp = ctx->temp;
        out->reference = ctx->reference;
        out->relativealt = ctx->relativealt;
        out->fresh = is_fresh;
        out->pressure_valid = is_fresh && ctx->pressure_valid;
        out->temp_valid = is_fresh && ctx->temp_valid;
        out->reference_valid = ctx->reference_valid;
        out->alt_valid = is_fresh && ctx->alt_valid;
        out->valid = is_fresh && ctx->valid;
    }

    return is_fresh;
}
