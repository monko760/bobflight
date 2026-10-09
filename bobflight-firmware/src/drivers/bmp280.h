/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BF_BMP280_H
#define BF_BMP280_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BMP280_CHIP_ID                  0x58
#define BMP280_I2C_ADDR_PRIMARY         0x76
#define BMP280_I2C_ADDR_SECONDARY       0x77

#define BMP280_REG_TRIM_START           0x88
#define BMP280_REG_CHIP_ID              0xD0
#define BMP280_REG_STATUS               0xF3
#define BMP280_REG_CTRL_MEAS            0xF4
#define BMP280_REG_CONFIG               0xF5
#define BMP280_REG_DATA_START           0xF7

#define BMP280_CTRL_MEAS_FORCED_X1T_X4P 0x2D

typedef enum {
    BMP280_STATE_UNINIT = 0,
    BMP280_STATE_PROBE,
    BMP280_STATE_CHECK_NVM,
    BMP280_STATE_READ_TRIM,
    BMP280_STATE_TRIGGER_CONV,
    BMP280_STATE_WAIT_CONV,
    BMP280_STATE_POLL_STATUS,
    BMP280_STATE_READ_DATA,
    BMP280_STATE_READY,
    BMP280_STATE_FAILED
} bmp280_state_t;

typedef struct {
    bool (*begin)(uint8_t addr, uint8_t reg, void *data, size_t len, bool read, uint32_t now);
    int (*poll)(uint32_t now); /* -1 error, 0 pending, 1 complete */
    void (*cancel)(void);
    void *user_data;
} bmp280_io_t;

typedef struct {
    uint16_t dig_T1;
    int16_t  dig_T2;
    int16_t  dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2;
    int16_t  dig_P3;
    int16_t  dig_P4;
    int16_t  dig_P5;
    int16_t  dig_P6;
    int16_t  dig_P7;
    int16_t  dig_P8;
    int16_t  dig_P9;
} bmp280_trim_t;

typedef struct {
    bmp280_state_t state;
    const char *reason;
    uint8_t address;
    uint32_t sample_seq;
    uint32_t sampletime;
    uint32_t age_ms;
    float pressure;
    float temp;
    float reference;
    float relativealt;

    bool fresh;
    bool pressure_valid;
    bool temp_valid;
    bool reference_valid;
    bool alt_valid;
    bool valid;
} bmp280_snapshot_t;

typedef struct {
    bmp280_io_t io;
    bmp280_state_t state;
    const char *reason;
    uint8_t address;
    uint8_t probe_idx; /* 0 for 0x76, 1 for 0x77 */

    bmp280_trim_t trim;

    uint8_t io_buf[24];
    uint32_t step_start_ms;
    uint32_t conv_start_ms;
    uint32_t last_conv_ms;
    uint32_t fail_time_ms;

    float p_acc;
    uint32_t ref_count;

    uint32_t sample_seq;
    uint32_t sampletime;
    float pressure;
    float temp;
    float reference;
    float relativealt;

    bool fresh;
    bool pressure_valid;
    bool temp_valid;
    bool reference_valid;
    bool alt_valid;
    bool valid;
} bmp280_t;

bool bmp280_init(bmp280_t *ctx, const bmp280_io_t *io, uint32_t now);
void bmp280_poll(bmp280_t *ctx, uint32_t now);
bool bmp280_snapshot(bmp280_t *ctx, uint32_t now, bmp280_snapshot_t *out);

#endif /* BF_BMP280_H */
