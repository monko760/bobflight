/* SPDX-License-Identifier: Apache-2.0 */
#include "drivers/bmp280.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint8_t regs[256];
    bool addr_nack[256];
    
    uint8_t cur_addr;
    uint8_t cur_reg;
    uint8_t *cur_buf;
    size_t cur_len;
    bool cur_read;
    bool in_tx;

    int nvm_busy_count;
    int measuring_busy_count;
    bool cancel_called;
} fakebus_t;

static fakebus_t g_fakebus;

static void fakebus_reset(void) {
    memset(&g_fakebus, 0, sizeof(g_fakebus));
}

static bool fakebus_begin(uint8_t addr, uint8_t reg, void *data, size_t len, bool read, uint32_t now) {
    (void)now;
    g_fakebus.cur_addr = addr;
    g_fakebus.cur_reg = reg;
    g_fakebus.cur_buf = (uint8_t *)data;
    g_fakebus.cur_len = len;
    g_fakebus.cur_read = read;
    g_fakebus.in_tx = true;

    if (!read && data && len > 0) {
        for (size_t i = 0; i < len; i++) {
            g_fakebus.regs[(reg + i) & 0xFF] = ((uint8_t *)data)[i];
        }
    }
    return true;
}

static int fakebus_poll(uint32_t now) {
    (void)now;
    if (!g_fakebus.in_tx) return -1;
    if (g_fakebus.addr_nack[g_fakebus.cur_addr]) return -1;

    if (g_fakebus.cur_read && g_fakebus.cur_buf) {
        for (size_t i = 0; i < g_fakebus.cur_len; i++) {
            uint8_t r = (g_fakebus.cur_reg + i) & 0xFF;
            if (r == BMP280_REG_STATUS) {
                uint8_t val = g_fakebus.regs[BMP280_REG_STATUS];
                if (g_fakebus.nvm_busy_count > 0) {
                    val |= 0x01; /* im_update bit */
                    g_fakebus.nvm_busy_count--;
                }
                if (g_fakebus.measuring_busy_count > 0) {
                    val |= 0x08; /* measuring bit */
                    g_fakebus.measuring_busy_count--;
                }
                g_fakebus.cur_buf[i] = val;
            } else {
                g_fakebus.cur_buf[i] = g_fakebus.regs[r];
            }
        }
    }
    return 1; /* Complete immediately */
}

static void fakebus_cancel(void) {
    g_fakebus.in_tx = false;
    g_fakebus.cancel_called = true;
}

static bmp280_io_t get_fakebus_io(void) {
    bmp280_io_t io = {
        .begin = fakebus_begin,
        .poll = fakebus_poll,
        .cancel = fakebus_cancel,
        .user_data = &g_fakebus
    };
    return io;
}

static void setup_fixture_trim(uint8_t *regs) {
    /* T1=27504, T2=26435, T3=-1000, P1=36477, P2=-10685, P3=3024, P4=2855, P5=140, P6=-7, P7=15500, P8=-14600, P9=6000 */
    uint16_t T1 = 27504;
    int16_t  T2 = 26435;
    int16_t  T3 = -1000;
    uint16_t P1 = 36477;
    int16_t  P2 = -10685;
    int16_t  P3 = 3024;
    int16_t  P4 = 2855;
    int16_t  P5 = 140;
    int16_t  P6 = -7;
    int16_t  P7 = 15500;
    int16_t  P8 = -14600;
    int16_t  P9 = 6000;

    regs[0x88] = T1 & 0xFF; regs[0x89] = (T1 >> 8) & 0xFF;
    regs[0x8A] = T2 & 0xFF; regs[0x8B] = (T2 >> 8) & 0xFF;
    regs[0x8C] = T3 & 0xFF; regs[0x8D] = (T3 >> 8) & 0xFF;

    regs[0x8E] = P1 & 0xFF; regs[0x8F] = (P1 >> 8) & 0xFF;
    regs[0x90] = P2 & 0xFF; regs[0x91] = (P2 >> 8) & 0xFF;
    regs[0x92] = P3 & 0xFF; regs[0x93] = (P3 >> 8) & 0xFF;
    regs[0x94] = P4 & 0xFF; regs[0x95] = (P4 >> 8) & 0xFF;
    regs[0x96] = P5 & 0xFF; regs[0x97] = (P5 >> 8) & 0xFF;
    regs[0x98] = P6 & 0xFF; regs[0x99] = (P6 >> 8) & 0xFF;
    regs[0x9A] = P7 & 0xFF; regs[0x9B] = (P7 >> 8) & 0xFF;
    regs[0x9C] = P8 & 0xFF; regs[0x9D] = (P8 >> 8) & 0xFF;
    regs[0x9E] = P9 & 0xFF; regs[0x9F] = (P9 >> 8) & 0xFF;
}

static void set_fixture_raw_sample(uint8_t *regs, uint32_t raw_T, uint32_t raw_P) {
    /* Pressure F7, F8, F9 */
    regs[0xF7] = (raw_P >> 12) & 0xFF;
    regs[0xF8] = (raw_P >> 4) & 0xFF;
    regs[0xF9] = (raw_P << 4) & 0xF0;

    /* Temp FA, FB, FC */
    regs[0xFA] = (raw_T >> 12) & 0xFF;
    regs[0xFB] = (raw_T >> 4) & 0xFF;
    regs[0xFC] = (raw_T << 4) & 0xF0;
}

static void run_one_conversion_cycle(bmp280_t *dev, uint32_t *now_ptr) {
    uint32_t now = *now_ptr;
    if (dev->state == BMP280_STATE_READY) {
        bmp280_poll(dev, now); /* READY -> TRIGGER_CONV */
    }
    if (dev->state == BMP280_STATE_TRIGGER_CONV) {
        bmp280_poll(dev, now); /* TRIGGER_CONV -> WAIT_CONV */
    }
    assert(dev->state == BMP280_STATE_WAIT_CONV);
    now += 15;
    bmp280_poll(dev, now); /* WAIT_CONV -> POLL_STATUS */
    assert(dev->state == BMP280_STATE_POLL_STATUS);
    bmp280_poll(dev, now); /* POLL_STATUS -> READ_DATA */
    assert(dev->state == BMP280_STATE_READ_DATA);
    bmp280_poll(dev, now); /* READ_DATA -> READY */
    assert(dev->state == BMP280_STATE_READY);
    now += 35;
    *now_ptr = now;
}

static void test_probe_fallback(void) {
    printf("[TEST] test_probe_fallback...\n");
    fakebus_reset();
    g_fakebus.addr_nack[0x76] = true;
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    setup_fixture_trim(g_fakebus.regs);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    assert(bmp280_init(&dev, &io, now));
    assert(dev.state == BMP280_STATE_PROBE);
    assert(dev.address == 0x76);

    bmp280_poll(&dev, now); /* Should handle NACK on 0x76 and try 0x77 */
    assert(dev.state == BMP280_STATE_PROBE);
    assert(dev.address == 0x77);

    bmp280_poll(&dev, now); /* Probe 0x77 succeeds -> moves to CHECK_NVM */
    assert(dev.state == BMP280_STATE_CHECK_NVM);
    printf("  PASS: fell back from 0x76 NACK to 0x77 successfully\n");
}

static void test_wrong_id_and_nack(void) {
    printf("[TEST] test_wrong_id_and_nack...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = 0x55; /* Wrong chip ID */
    g_fakebus.addr_nack[0x77] = true; /* 0x77 NACKs */

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    assert(bmp280_init(&dev, &io, now));
    bmp280_poll(&dev, now); /* 0x76 wrong chip ID -> switches to 0x77 */
    assert(dev.address == 0x77);

    bmp280_poll(&dev, now); /* 0x77 NACK -> fails */
    assert(dev.state == BMP280_STATE_FAILED);
    printf("  PASS: failed cleanly on wrong chip ID and NACK\n");
}

static void test_nvm_check_and_trim_24(void) {
    printf("[TEST] test_nvm_check_and_trim_24...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    g_fakebus.nvm_busy_count = 2; /* Returns im_update=1 twice before clearing */
    setup_fixture_trim(g_fakebus.regs);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* Probe 0x76 ok -> CHECK_NVM */
    assert(dev.state == BMP280_STATE_CHECK_NVM);

    bmp280_poll(&dev, now); /* NVM busy 1 */
    assert(dev.state == BMP280_STATE_CHECK_NVM);

    bmp280_poll(&dev, now); /* NVM busy 2 */
    assert(dev.state == BMP280_STATE_CHECK_NVM);

    bmp280_poll(&dev, now); /* NVM clear -> READ_TRIM */
    assert(dev.state == BMP280_STATE_READ_TRIM);

    bmp280_poll(&dev, now); /* Read trim 24 bytes -> TRIGGER_CONV */
    assert(dev.state == BMP280_STATE_TRIGGER_CONV);

    /* Verify trim parameter parsing */
    assert(dev.trim.dig_T1 == 27504);
    assert(dev.trim.dig_T2 == 26435);
    assert(dev.trim.dig_T3 == -1000);
    assert(dev.trim.dig_P1 == 36477);
    assert(dev.trim.dig_P2 == -10685);
    assert(dev.trim.dig_P3 == 3024);
    assert(dev.trim.dig_P4 == 2855);
    assert(dev.trim.dig_P5 == 140);
    assert(dev.trim.dig_P6 == -7);
    assert(dev.trim.dig_P7 == 15500);
    assert(dev.trim.dig_P8 == -14600);
    assert(dev.trim.dig_P9 == 6000);
    printf("  PASS: NVM update polling and 24-byte trim parsing verified\n");
}

static void test_bad_trim_rejection(void) {
    printf("[TEST] test_bad_trim_rejection...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    memset(&g_fakebus.regs[BMP280_REG_TRIM_START], 0, 24); /* All zeros trim */

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* PROBE */
    bmp280_poll(&dev, now); /* CHECK_NVM */
    bmp280_poll(&dev, now); /* READ_TRIM */
    assert(dev.state == BMP280_STATE_FAILED);
    assert(strcmp(dev.reason, "bad_trim") == 0);
    printf("  PASS: bad trim rejected\n");
}

static void test_reference_fixture_math(void) {
    printf("[TEST] test_reference_fixture_math...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    setup_fixture_trim(g_fakebus.regs);
    set_fixture_raw_sample(g_fakebus.regs, 519888, 415148);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* PROBE -> CHECK_NVM */
    bmp280_poll(&dev, now); /* CHECK_NVM -> READ_TRIM */
    bmp280_poll(&dev, now); /* READ_TRIM -> TRIGGER_CONV */

    assert(dev.state == BMP280_STATE_TRIGGER_CONV);
    bmp280_poll(&dev, now); /* TRIGGER_CONV writes 0x2D -> WAIT_CONV */
    assert(dev.state == BMP280_STATE_WAIT_CONV);
    assert(g_fakebus.regs[BMP280_REG_CTRL_MEAS] == BMP280_CTRL_MEAS_FORCED_X1T_X4P);

    now += 15;
    bmp280_poll(&dev, now); /* WAIT_CONV -> POLL_STATUS */
    assert(dev.state == BMP280_STATE_POLL_STATUS);

    bmp280_poll(&dev, now); /* POLL_STATUS ok -> READ_DATA */
    assert(dev.state == BMP280_STATE_READ_DATA);

    bmp280_poll(&dev, now); /* READ_DATA -> READY */
    assert(dev.state == BMP280_STATE_READY);
    assert(dev.sample_seq == 1);

    bmp280_snapshot_t snap;
    assert(bmp280_snapshot(&dev, now, &snap));
    assert(snap.fresh);
    assert(snap.valid);
    assert(snap.temp_valid);
    assert(snap.pressure_valid);

    /* Verify math outputs: rawT=519888 rawP=415148 -> about 25.08C 100653.25Pa */
    printf("  Reference fixture output: Temp = %.4f C, Pressure = %.2f Pa\n", snap.temp, snap.pressure);
    assert(snap.temp >= 25.07f && snap.temp <= 25.09f);
    assert(snap.pressure >= 100650.0f && snap.pressure <= 100656.0f);
    printf("  PASS: reference fixture math exact match\n");
}

static void test_status_busy_timeout(void) {
    printf("[TEST] test_status_busy_timeout...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    g_fakebus.measuring_busy_count = 1000; /* Stays measuring forever */
    setup_fixture_trim(g_fakebus.regs);
    set_fixture_raw_sample(g_fakebus.regs, 519888, 415148);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* PROBE */
    bmp280_poll(&dev, now); /* CHECK_NVM */
    bmp280_poll(&dev, now); /* READ_TRIM */
    bmp280_poll(&dev, now); /* TRIGGER_CONV */

    now += 15;
    bmp280_poll(&dev, now); /* WAIT_CONV -> POLL_STATUS */

    for (int i = 0; i < 10; i++) {
        bmp280_poll(&dev, now); /* Keeps reading status bit 3 = 1 */
        if (dev.state == BMP280_STATE_FAILED) break;
        now += 10;
    }

    assert(dev.state == BMP280_STATE_FAILED);
    assert(strcmp(dev.reason, "measuring_timeout") == 0);
    printf("  PASS: status measuring busy timeout handled\n");
}

static void test_freshness_and_stale_timeout(void) {
    printf("[TEST] test_freshness_and_stale_timeout...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    setup_fixture_trim(g_fakebus.regs);
    set_fixture_raw_sample(g_fakebus.regs, 519888, 415148);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now);
    bmp280_poll(&dev, now);
    bmp280_poll(&dev, now);

    run_one_conversion_cycle(&dev, &now);

    assert(dev.state == BMP280_STATE_READY);
    bmp280_snapshot_t snap;

    uint32_t t_sample = dev.sampletime;

    /* Fresh at t_sample + 10ms */
    assert(bmp280_snapshot(&dev, t_sample + 10, &snap));
    assert(snap.fresh);

    /* Fresh at t_sample + 245ms */
    assert(bmp280_snapshot(&dev, t_sample + 245, &snap));
    assert(snap.fresh);

    /* Stale at t_sample + 255ms */
    assert(!bmp280_snapshot(&dev, t_sample + 255, &snap));
    assert(!snap.fresh);
    printf("  PASS: snapshot freshness and 250ms staleness verified\n");
}

static void test_reference_32_samples_and_altitude_sign(void) {
    printf("[TEST] test_reference_32_samples_and_altitude_sign...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    setup_fixture_trim(g_fakebus.regs);
    set_fixture_raw_sample(g_fakebus.regs, 519888, 415148);

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* PROBE */
    bmp280_poll(&dev, now); /* CHECK_NVM */
    bmp280_poll(&dev, now); /* READ_TRIM */

    bmp280_snapshot_t snap;

    /* Run 31 conversion cycles */
    for (int i = 0; i < 31; i++) {
        run_one_conversion_cycle(&dev, &now);
        bmp280_snapshot(&dev, now, &snap);
        assert(!snap.reference_valid);
        assert(!snap.alt_valid);
    }

    /* 32nd conversion cycle */
    run_one_conversion_cycle(&dev, &now);
    bmp280_snapshot(&dev, now, &snap);
    assert(snap.reference_valid);
    assert(snap.alt_valid);
    float ref_p = snap.reference;
    printf("  32-sample reference pressure = %.2f Pa\n", ref_p);
    assert(fabsf(snap.relativealt) < 0.1f); /* ~0 cm at reference pressure */

    /* 33rd conversion cycle: raw_P = 420000 -> lower pressure -> higher altitude (> 0 cm) */
    set_fixture_raw_sample(g_fakebus.regs, 519888, 420000);
    run_one_conversion_cycle(&dev, &now);

    bmp280_snapshot(&dev, now, &snap);
    assert(snap.pressure < ref_p);
    assert(snap.relativealt > 0.0f); /* Lower pressure -> positive altitude */
    printf("  Lower pressure (%.2f Pa) relative alt = %.2f cm (> 0)\n", snap.pressure, snap.relativealt);

    /* 34th conversion cycle: raw_P = 410000 -> higher pressure -> lower altitude (< 0 cm) */
    set_fixture_raw_sample(g_fakebus.regs, 519888, 410000);
    run_one_conversion_cycle(&dev, &now);

    bmp280_snapshot(&dev, now, &snap);
    assert(snap.pressure > ref_p);
    assert(snap.relativealt < 0.0f); /* Higher pressure -> negative altitude */
    printf("  Higher pressure (%.2f Pa) relative alt = %.2f cm (< 0)\n", snap.pressure, snap.relativealt);
    printf("  PASS: 32-sample reference accumulation and altitude sign verified\n");
}

static void test_sentinel_rejection(void) {
    printf("[TEST] test_sentinel_rejection...\n");
    fakebus_reset();
    g_fakebus.regs[BMP280_REG_CHIP_ID] = BMP280_CHIP_ID;
    setup_fixture_trim(g_fakebus.regs);
    set_fixture_raw_sample(g_fakebus.regs, 0x80000, 415148); /* 0x80000 disabled sentinel */

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now);
    bmp280_poll(&dev, now);
    bmp280_poll(&dev, now);

    run_one_conversion_cycle(&dev, &now);

    bmp280_snapshot_t snap;
    bool fresh = bmp280_snapshot(&dev, now, &snap);
    assert(!fresh);
    assert(!snap.fresh);
    assert(!snap.valid);
    printf("  PASS: raw 0x80000 sentinel sample rejected and freshness invalidated\n");
}

static void test_fail_retry_bounded_1s(void) {
    printf("[TEST] test_fail_retry_bounded_1s...\n");
    fakebus_reset();
    g_fakebus.addr_nack[0x76] = true;
    g_fakebus.addr_nack[0x77] = true;

    bmp280_t dev;
    bmp280_io_t io = get_fakebus_io();
    uint32_t now = 1000;

    bmp280_init(&dev, &io, now);
    bmp280_poll(&dev, now); /* 0x76 NACK -> try 0x77 */
    bmp280_poll(&dev, now); /* 0x77 NACK -> STATE_FAILED */
    assert(dev.state == BMP280_STATE_FAILED);

    /* Advance time by 500ms -> should remain in FAILED */
    now += 500;
    bmp280_poll(&dev, now);
    assert(dev.state == BMP280_STATE_FAILED);

    /* Advance time to 1000ms after failure -> should attempt retry probe */
    now += 500;
    bmp280_poll(&dev, now);
    assert(dev.state == BMP280_STATE_PROBE);
    printf("  PASS: fail retry bounded to 1 second verified\n");
}

int main(void) {
    printf("=========================================\n");
    printf("RUNNING HOST BMP280 NATIVE FAKEBUS TESTS\n");
    printf("=========================================\n");

    test_probe_fallback();
    test_wrong_id_and_nack();
    test_nvm_check_and_trim_24();
    test_bad_trim_rejection();
    test_reference_fixture_math();
    test_status_busy_timeout();
    test_freshness_and_stale_timeout();
    test_reference_32_samples_and_altitude_sign();
    test_sentinel_rejection();
    test_fail_retry_bounded_1s();

    printf("=========================================\n");
    printf("ALL BMP280 TESTS PASSED SUCCESSFULLY!\n");
    printf("=========================================\n");
    return 0;
}
