/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gyro driver — clean-room register maps from public vendor datasheets only.
 * Never paste Betaflight / InvenSense driver sources. Pins from board_get().
 *
 * Public WHOAMI / chip-id (one-line cites):
 *   MPU6000-class: WHO_AM_I 0x75 → 0x68 (PS-MPU-6000A); MPU6500 → 0x70.
 *   ICM-42688-P: WHO_AM_I 0x75 → 0x47 (TDK DS-000347).
 *   BMI270: CHIP_ID 0x00 → 0x24 (Bosch BST-BMI270-DS000); SPI needs priming read.
 */
#include "drivers/gyro.h"
#include "drivers/sensor_calibration.h"
#include "board/board.h"
#include "hal/hal.h"
#include "flight/arming.h"

#include <string.h>
#include <math.h>
static float g_acc[3], g_latest[3], g_filter[3];
static sensor_calibration_t g_cal;
static bool g_manual;
static uint32_t g_client_ms;
static gyro_diagnostics_t g_diag;

typedef enum {
    GYRO_CHIP_NONE = 0,
    GYRO_CHIP_MPU6K,
    GYRO_CHIP_ICM42688,
    GYRO_CHIP_BMI270
} gyro_chip_kind_t;

static bool g_healthy;
static hal_spi_bus_t *g_spi;
static hal_pin_t g_cs;
static const char *g_bind = "unbound";
static gyro_chip_kind_t g_kind;
static float g_dps_per_lsb = 1.f / 16.4f; /* ±2000 dps common scale */

#if BOBFLIGHT_HOST
static bool g_host_inject;
static float g_host_dps[3];
#endif

/* Invensense SPI: address bit7 = read. */
static bool gyro_spi_read_regs(uint8_t start_reg, uint8_t *dst, size_t n)
{
    uint8_t tx[16];
    uint8_t rx[16];
    size_t i;
    if (!g_spi || !dst || n == 0 || n + 1u > sizeof(tx)) {
        return false;
    }
    memset(tx, 0, n + 1u);
    tx[0] = (uint8_t)(start_reg | 0x80u);
    if (!hal_spi_transfer(g_spi, g_cs, tx, rx, n + 1u)) {
        return false;
    }
    for (i = 0; i < n; i++) {
        dst[i] = rx[i + 1u];
    }
    return true;
}

static bool gyro_spi_write_reg(uint8_t reg, uint8_t val)
{
    uint8_t tx[2];
    uint8_t rx[2];
    if (!g_spi) {
        return false;
    }
    tx[0] = (uint8_t)(reg & 0x7Fu);
    tx[1] = val;
    return hal_spi_transfer(g_spi, g_cs, tx, rx, 2);
}

/* BMI270 SPI: after address, one dummy clocked byte then payload (datasheet SPI). */
static bool bmi_spi_read_regs(uint8_t start_reg, uint8_t *dst, size_t n)
{
    uint8_t tx[17];
    uint8_t rx[17];
    size_t i;
    if (!g_spi || !dst || n == 0 || n + 2u > sizeof(tx)) {
        return false;
    }
    memset(tx, 0, n + 2u);
    tx[0] = (uint8_t)(start_reg | 0x80u);
    if (!hal_spi_transfer(g_spi, g_cs, tx, rx, n + 2u)) {
        return false;
    }
    for (i = 0; i < n; i++) {
        dst[i] = rx[i + 2u];
    }
    return true;
}

static uint8_t gyro_whoami_inv(void)
{
    uint8_t id = 0;
    if (!gyro_spi_read_regs(0x75u, &id, 1)) {
        return 0;
    }
    return id;
}

static uint8_t gyro_chipid_bmi(void)
{
    uint8_t id = 0;
    uint8_t discard = 0;
    /* Priming read switches interface from I2C default to SPI (Bosch DS). */
    (void)bmi_spi_read_regs(0x00u, &discard, 1);
    if (!bmi_spi_read_regs(0x00u, &id, 1)) {
        return 0;
    }
    return id;
}

static bool configure_mpu6k(void)
{
    g_diag.chip="MPU6K-class";
    if(!gyro_spi_write_reg(0x6B,0x80))return false;
    hal_delay_ms(100);
    if(!gyro_spi_write_reg(0x68,0x07))return false;
    hal_delay_ms(100);
    if(!gyro_spi_write_reg(0x6B,0x01) || !gyro_spi_write_reg(0x6C,0) ||
       !gyro_spi_write_reg(0x6A,0x10) || !gyro_spi_write_reg(0x19,0) ||
       !gyro_spi_write_reg(0x1A,3) || !gyro_spi_write_reg(0x1B,0x18) ||
       !gyro_spi_write_reg(0x1C,0x10) || !gyro_spi_write_reg(0x38,1))return false;
    hal_delay_ms(20);
    uint8_t pwr, divider, filter;
    g_diag.gyro_config = g_diag.accel_config = 0xff;
    if(!gyro_spi_read_regs(0x1B,&g_diag.gyro_config,1) ||
       !gyro_spi_read_regs(0x1C,&g_diag.accel_config,1) ||
       !gyro_spi_read_regs(0x6B,&pwr,1) ||
       !gyro_spi_read_regs(0x19,&divider,1) ||
       !gyro_spi_read_regs(0x1A,&filter,1))return false;
    if(g_diag.gyro_config!=0x18 || g_diag.accel_config!=0x10 ||
       pwr!=0x01 || divider!=0 || filter!=3)return false;
    g_diag.config_ok=true;
    g_dps_per_lsb=1.f/16.4f;
    return true;
}

static bool configure_icm42688(void)
{
    /* Soft reset DEVICE_CONFIG; then LN gyro+accel; GYRO_CONFIG0 ±2000/1kHz. */
    (void)gyro_spi_write_reg(0x11u, 0x01u);
    hal_delay_ms(2);
    if (!gyro_spi_write_reg(0x4Eu, 0x0Fu)) {
        return false;
    }
    if (!gyro_spi_write_reg(0x4Fu, 0x06u)) {
        return false;
    }
    g_dps_per_lsb = 1.f / 16.4f;
    return true;
}

static bool configure_bmi270(void)
{
    /*
     * Full BMI270 needs config-file load (deferred). Soft-reset + CMD path
     * only; sample may stay quiet until Hardware lands config blob.
     */
    if (!gyro_spi_write_reg(0x7Eu, 0xB6u)) {
        return false;
    }
    hal_delay_ms(2);
    g_dps_per_lsb = 1.f / 16.4f;
    return true;
}

static bool probe_and_configure(const char *chip_str)
{
    uint8_t id;
    g_kind = GYRO_CHIP_NONE;

    /* MULTI / unknown: try public IDs in order MPU → ICM → BMI. */
    if (!chip_str || chip_str[0] == '\0' ||
        strcmp(chip_str, "none") == 0 ||
        strstr(chip_str, "MULTI") != NULL) {
        id = gyro_whoami_inv();
        if (id == 0x68u || id == 0x70u || id == 0x71u) {
            g_kind = GYRO_CHIP_MPU6K;
            return configure_mpu6k();
        }
        if (id == 0x47u) {
            g_kind = GYRO_CHIP_ICM42688;
            return configure_icm42688();
        }
        id = gyro_chipid_bmi();
        if (id == 0x24u) {
            g_kind = GYRO_CHIP_BMI270;
            return configure_bmi270();
        }
        return false;
    }

    if (strstr(chip_str, "MPU") != NULL || strstr(chip_str, "ICM206") != NULL) {
        id = gyro_whoami_inv();
        if (id == 0x68u || id == 0x70u || id == 0x71u) {
            g_kind = GYRO_CHIP_MPU6K;
            return configure_mpu6k();
        }
        return false;
    }
    if (strstr(chip_str, "ICM42688") != NULL || strstr(chip_str, "ICM-42688") != NULL) {
        id = gyro_whoami_inv();
        if (id == 0x47u) {
            g_kind = GYRO_CHIP_ICM42688;
            return configure_icm42688();
        }
        return false;
    }
    if (strstr(chip_str, "BMI270") != NULL) {
        id = gyro_chipid_bmi();
        if (id == 0x24u) {
            g_kind = GYRO_CHIP_BMI270;
            return configure_bmi270();
        }
        return false;
    }

    /* Fallback probe for any other chip string. */
    id = gyro_whoami_inv();
    if (id == 0x68u || id == 0x70u || id == 0x71u) {
        g_kind = GYRO_CHIP_MPU6K;
        return configure_mpu6k();
    }
    if (id == 0x47u) {
        g_kind = GYRO_CHIP_ICM42688;
        return configure_icm42688();
    }
    id = gyro_chipid_bmi();
    if (id == 0x24u) {
        g_kind = GYRO_CHIP_BMI270;
        return configure_bmi270();
    }
    return false;
}

static int16_t be16(const uint8_t *p)
{
    return (int16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
}

static int16_t le16(const uint8_t *p)
{
    return (int16_t)(((uint16_t)p[1] << 8) | (uint16_t)p[0]);
}

void gyro_init(void)
{
    const board_t *b = board_get();
    memset(&g_diag,0,sizeof(g_diag));
    g_diag.chip="unavailable";
    g_diag.gyro_config=g_diag.accel_config=0xff;
    sc_init(&g_cal);g_manual=false;
    gyro_begin_calibration();
    memset(g_acc,0,sizeof(g_acc));
    memset(g_latest,0,sizeof(g_latest));
    memset(g_filter,0,sizeof(g_filter));
    g_spi = NULL;
    g_cs = HAL_PIN_INVALID;
    g_healthy = false;
    g_kind = GYRO_CHIP_NONE;
    g_bind = "unbound";
#if BOBFLIGHT_HOST
    g_host_inject = false;
    g_host_dps[0] = g_host_dps[1] = g_host_dps[2] = 0.f;
#endif

    if (!b || !board_pins_live()) {
        g_bind = b && b->is_dummy ? "dummy" : "unbound";
        arming_set_gyro_healthy(false);
        return;
    }
    if (!hal_pin_valid(b->gyro_cs_pin)) {
        g_bind = "no-cs";
        arming_set_gyro_healthy(false);
        return;
    }
    if (b->gyro_spi_bus == 0) {
        g_bind = "no-spi";
        arming_set_gyro_healthy(false);
        return;
    }

    g_spi = hal_spi_open(b->gyro_spi_bus);
    g_cs = b->gyro_cs_pin;
    if (!g_spi) {
        g_bind = "no-spi";
        arming_set_gyro_healthy(false);
        return;
    }

    if (hal_pin_valid(b->gyro_exti_pin) && board_mmio_permitted()) {
        (void)hal_exti_attach(b->gyro_exti_pin, NULL, NULL);
    }

    if (probe_and_configure(b->gyro_chip)) {
        g_diag.chip=g_kind==GYRO_CHIP_MPU6K ? "MPU6K-class" :
                    g_kind==GYRO_CHIP_ICM42688 ? "ICM42688-calibration-unsupported" : "BMI270-calibration-unsupported";
        g_healthy = true;
        g_bind = "ok";
        arming_set_gyro_healthy(true);
        return;
    }

    /* Host SPI zeros → WHOAMI fail-closed. Keep CLI contract labels. */
    g_healthy = false;
    g_bind = b->ir_bf_derived ? "bf-derived" : "unbound";
    arming_set_gyro_healthy(false);
}

bool gyro_sample(float dps[3])
{
    uint8_t raw[14];
    int16_t x, y, z;

    if (dps) {
        dps[0] = dps[1] = dps[2] = 0.f;
    }
#if BOBFLIGHT_HOST
    if (g_host_inject) {
        if (!g_healthy || !dps) {
            return false;
        }
        dps[0] = g_host_dps[0];
        dps[1] = g_host_dps[1];
        dps[2] = g_host_dps[2];
        return true;
    }
#endif
    if (!g_healthy || !g_spi || !dps) {
        return false;
    }

    switch (g_kind) {
    case GYRO_CHIP_MPU6K: {
        /* Count only fresh hardware samples, not repeated reads of output regs.
         * INT_STATUS.DATA_RDY (MPU register map RM-MPU-6000A-00, 0x3A). */
        uint8_t ready=0;
        if(!gyro_spi_read_regs(0x3A,&ready,1)) {
            g_healthy=false; arming_set_gyro_healthy(false); return false;
        }
        if(!(ready & 1u)) {
            if(g_diag.sample_seq && (uint32_t)(hal_millis()-g_diag.sample_ms)<=20u) {
                memcpy(dps,g_latest,sizeof(g_latest)); return true;
            }
            return false;
        }
        /* GYRO_XOUT_H @ 0x43 — big-endian. */
        if (!gyro_spi_read_regs(0x3Bu, raw, 14)) {
            g_healthy=false; arming_set_gyro_healthy(false); return false;
        }
        g_acc[0]=(float)be16(raw)/4096.f;
        g_acc[1]=(float)be16(raw+2)/4096.f;
        g_acc[2]=(float)be16(raw+4)/4096.f;
        x=be16(raw+8); y=be16(raw+10); z=be16(raw+12);
        break;
    }
    case GYRO_CHIP_ICM42688:
        /* GYRO_DATA_X1 @ 0x25 — big-endian. */
        if (!gyro_spi_read_regs(0x25u, raw, 6)) {
            return false;
        }
        x = be16(&raw[0]);
        y = be16(&raw[2]);
        z = be16(&raw[4]);
        break;
    case GYRO_CHIP_BMI270:
        /* DATA_8..DATA_13 (0x0C) gyr — little-endian. */
        if (!bmi_spi_read_regs(0x0Cu, raw, 6)) {
            return false;
        }
        x = le16(&raw[0]);
        y = le16(&raw[2]);
        z = le16(&raw[4]);
        break;
    default:
        return false;
    }

    dps[0] = (float)x * g_dps_per_lsb;
    dps[1] = (float)y * g_dps_per_lsb;
    dps[2] = (float)z * g_dps_per_lsb;
    const board_t *b=board_get();
    if(b && strcmp(b->gyro_align,"CW270_DEG")==0) {
        float v=dps[0]; dps[0]=-dps[1];dps[1]=v;
        v=g_acc[0];g_acc[0]=-g_acc[1];g_acc[1]=v;
    }
    if(g_kind==GYRO_CHIP_MPU6K) {
        memcpy(g_diag.raw_acc_g,g_acc,sizeof(g_acc));
        g_diag.sample_ms=hal_millis();
        ++g_diag.sample_seq;
        if(!g_diag.sample_seq) ++g_diag.sample_seq; /* zero means no sample */
    }
    if(g_kind==GYRO_CHIP_MPU6K) {
        sc_feed(&g_cal,dps,g_diag.raw_acc_g,g_diag.sample_ms);
        sc_correct_accel(&g_cal,g_diag.raw_acc_g,g_acc);
    }
    for(unsigned i=0;i<3;i++){dps[i]-=g_cal.gyro_bias[i];g_latest[i]=dps[i];}
    return true;
}

bool gyro_is_healthy(void)
{
    return g_healthy;
}

const char *gyro_bind_state(void)
{
    return g_bind;
}

void gyro_filter(const float in_dps[3], float out_dps[3])
{
    if (!in_dps || !out_dps) {
        return;
    }
#if BOBFLIGHT_HOST
    memcpy(out_dps, in_dps, 3 * sizeof(float));
#else
    for(unsigned i=0;i<3;i++){g_filter[i]+=0.3345f*(in_dps[i]-g_filter[i]);out_dps[i]=g_filter[i];}
#endif
}

#if BOBFLIGHT_HOST
void gyro_host_inject_dps(const float dps[3], bool healthy)
{
    g_host_inject = true;
    g_healthy = healthy;
    if (dps) {
        g_host_dps[0] = dps[0];
        g_host_dps[1] = dps[1];
        g_host_dps[2] = dps[2];
    } else {
        g_host_dps[0] = g_host_dps[1] = g_host_dps[2] = 0.f;
    }
    arming_set_gyro_healthy(healthy);
}
#endif

void gyro_begin_calibration(void){sc_begin_gyro(&g_cal,hal_millis());}
bool gyro_calibrated(void){return g_cal.gyro_valid && g_cal.mode!=SC_GYRO && !g_manual;}
bool gyro_flight_ready(void) {
    if(!gyro_calibrated() || !g_cal.accel_valid || !g_healthy || !g_diag.config_ok ||
       !g_diag.sample_seq || (uint32_t)(hal_millis()-g_diag.sample_ms)>100u)return false;
    float norm=0.f;
    for(unsigned i=0;i<3;i++){if(!isfinite(g_acc[i]))return false;norm+=g_acc[i]*g_acc[i];}
    return norm>=0.81f && norm<=1.21f;
}
const float *gyro_accel_g(void){return g_acc;}
const float *gyro_latest_dps(void){return g_latest;}
const gyro_diagnostics_t *gyro_diagnostics(void){return &g_diag;}
static bool manual_sensor_ready(void) {
    return g_healthy && g_diag.config_ok && g_diag.sample_seq &&
        (uint32_t)(hal_millis()-g_diag.sample_ms)<=100u &&
        arming_state()!=ARM_ARMED && hal_usb_cdc_connected();
}
void gyro_calibration_tick(void) {
    uint32_t now=hal_millis();sc_tick(&g_cal,now);
    if(g_manual) {
        if(g_cal.mode==SC_COMPLETE || g_cal.mode==SC_ERROR || g_cal.mode==SC_IDLE)g_manual=false;
        else if(!manual_sensor_ready() || (uint32_t)(now-g_client_ms)>2000u) {
            sc_cancel(&g_cal,"cancelled-unsafe-stale-or-session-expired");g_manual=false;
        }
    }
}
void gyro_calibration_touch(void){g_client_ms=hal_millis();}
bool gyro_manual_calibration_active(void){return g_manual;}
bool gyro_start_manual_calibration(void) {
    if(g_manual || !manual_sensor_ready())return false;
    sc_begin_gyro(&g_cal,hal_millis());g_manual=true;gyro_calibration_touch();return true;
}
bool gyro_start_accel_calibration(void) {
    if(g_manual || !manual_sensor_ready())return false;
    sc_begin_accel(&g_cal,hal_millis());g_manual=true;gyro_calibration_touch();return true;
}
bool gyro_capture_accel_face(unsigned face) {
    if(!g_manual || !manual_sensor_ready())return false;
    bool ok=sc_capture_face(&g_cal,face,hal_millis());if(ok)gyro_calibration_touch();return ok;
}
bool gyro_apply_accel_calibration(void) {
    if(!g_manual || !manual_sensor_ready())return false;
    bool ok=sc_apply_accel(&g_cal);if(ok){g_manual=false;sc_correct_accel(&g_cal,g_diag.raw_acc_g,g_acc);}return ok;
}
void gyro_cancel_manual_calibration(void){sc_cancel(&g_cal,"cancelled");g_manual=false;}
void gyro_calibration_info(gyro_calibration_info_t *info) {
    if(!info)return;
    info->apply_detail=g_cal.apply_detail;info->candidate_valid=g_cal.candidate_valid;
    memcpy(info->candidate_bias,g_cal.candidate_bias,sizeof(info->candidate_bias));
    memcpy(info->candidate_scale,g_cal.candidate_scale,sizeof(info->candidate_scale));
    memcpy(info->face_mean,g_cal.face_mean,sizeof(info->face_mean));
    info->state=sc_state_name(&g_cal);info->reason=g_cal.reason;
    info->samples=g_cal.samples;info->required=sc_required(&g_cal);
    info->faces=g_cal.faces;info->face=g_cal.face;info->accel_valid=g_cal.accel_valid;
    memcpy(info->gyro_bias,g_cal.gyro_bias,sizeof(info->gyro_bias));
    memcpy(info->accel_bias,g_cal.accel_bias,sizeof(info->accel_bias));
    memcpy(info->accel_scale,g_cal.accel_scale,sizeof(info->accel_scale));
}
