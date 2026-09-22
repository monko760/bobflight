/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

#define main original_sd_tests_main
#include "host_sd_spi.c"
#undef main

#include "flight/arming.h"
#include "sched/tasks.h"
#include "drivers/gyro.h"
#include "hal/hal.h"

static bool armed, bench, cal, usb = true, bl_pending;
static uint64_t now;
static unsigned binds, cancels;
static char output[8192];

static void cli_write_str(const char *s) {
    assert(strlen(output) + strlen(s) < sizeof(output));
    strcat(output, s);
}

arm_state_t arming_state(void) { return armed ? ARM_ARMED : ARM_DISARMED; }
bool bench_motor_active(void) { return bench; }
bool gyro_manual_calibration_active(void) { return cal; }
bool hal_usb_cdc_connected(void) { return usb; }
uint64_t hal_micros(void) { return now; }
bool sd_spi_hw_bind(sd_spi_io_t *io) { binds++; *io = create_mock_io(); return true; }
void sd_spi_hw_cancel(void) { cancels++; g_mock.cs_asserted = false; g_mock.io_pending = false; }

#define BOBFLIGHT_SD_CLI_TEST 1
#include "drivers/sd_cli.h"

static void put16(uint8_t *b, uint16_t n) { b[0] = (uint8_t)n; b[1] = (uint8_t)(n >> 8); }
static void put32(uint8_t *b, uint32_t n) { put16(b, (uint16_t)n); put16(b + 2, (uint16_t)(n >> 16)); }
static void boot_exfat(uint8_t *b, uint32_t offset) {
    memset(b, 0, 512); memcpy(b + 3, "EXFAT   ", 8); b[510] = 0x55; b[511] = 0xaa;
    put32(b + 64, offset); put32(b + 72, 100000); put32(b + 80, 24); put32(b + 84, 800);
    put32(b + 88, 824); put32(b + 92, 99176); put32(b + 96, 2); b[108] = 9; b[109] = 0;
    b[110] = 1; put16(b + 106, 2);
}

static uint32_t calculate_expected_crc32(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1u));
        }
    }
    return ~crc;
}

static void drive_probe_done(void) {
    output[0] = 0;
    assert(cmd_sd("sd probe"));
    for (unsigned i = 0; i < 10000 && cli_sd.phase != SD_PROBE_DONE; i++) {
        now += 10;
        sd_cli_poll();
    }
    assert(cli_sd.phase == SD_PROBE_DONE);
}

int main(void) {
    reset_mock_card(MOCK_CARD_SDHC_64GB);
    boot_exfat(g_mock.memory[0], 0);

    /* 1. Malformed offset parsing tests */
    drive_probe_done();
    const char *malformed[] = {
        "sd read",
        "sd read -1",
        "sd read +10",
        "sd read 01",
        "sd read 00",
        "sd read 10abc",
        "sd read 10 ",
        "sd read  10",
        "sd read 99999999999999999999",
        "sd read 4294967296"
    };
    for (size_t i = 0; i < sizeof(malformed) / sizeof(malformed[0]); i++) {
        output[0] = 0;
        assert(cmd_sd(malformed[i]));
        assert(strstr(output, "sd_data_error: malformed sector argument"));
        assert(strstr(output, "sd_data_end: 1"));
    }

    /* 2. Bounds check test */
    output[0] = 0;
    assert(cmd_sd("sd read 125000705"));
    assert(strstr(output, "sd_data_error: sector out of bounds"));
    assert(strstr(output, "sd_data_end: 1"));

    /* 3. Guard rejection prior to start */
    for (unsigned kind = 0; kind < 5; kind++) {
        armed = kind == 0; bench = kind == 1; cal = kind == 2; usb = kind != 3; bl_pending = kind == 4;
        output[0] = 0;
        assert(cmd_sd("sd read 0"));
        assert(strstr(output, "sd_data_error: disarm, stop motor tests/calibration, connect USB required"));
        assert(strstr(output, "sd_data_end: 1"));
    }
    armed = bench = cal = bl_pending = false; usb = true;

    /* 4. Successful read content, CRC32, framing */
    output[0] = 0;
    assert(cmd_sd("sd read 0"));
    assert(sd_read_busy());
    for (unsigned i = 0; i < 10000 && sd_read_busy(); i++) {
        now += 10;
        sd_cli_poll();
    }
    assert(!sd_read_busy());
    assert(strstr(output, "sd_data_api: 1\r\n"));
    assert(strstr(output, "sd_data_sector: 0\r\n"));
    assert(strstr(output, "sd_data_hex: "));
    assert(strstr(output, "sd_data_end: 1\r\n"));

    /* Extract hex string and verify CRC32 and length */
    char *hex_start = strstr(output, "sd_data_hex: ") + 13;
    char *crc_line = strstr(output, "\r\nsd_data_crc32: ");
    assert(hex_start && crc_line);
    size_t hex_len = crc_line - hex_start;
    assert(hex_len == 1024);

    uint8_t read_sector_data[512];
    for (size_t b = 0; b < 512; b++) {
        char hex_byte[3] = { hex_start[b * 2], hex_start[b * 2 + 1], '\0' };
        read_sector_data[b] = (uint8_t)strtoul(hex_byte, NULL, 16);
    }
    /* Verify read bytes match sector 0 of mock card memory */
    assert(memcmp(read_sector_data, g_mock.memory[0], 512) == 0);

    uint32_t expected_crc = calculate_expected_crc32(read_sector_data, 512);
    char expected_crc_str[32];
    snprintf(expected_crc_str, sizeof(expected_crc_str), "sd_data_crc32: %08X", expected_crc);
    assert(strstr(output, expected_crc_str));

    /* 5. Reject other commands while read in progress */
    drive_probe_done();
    output[0] = 0;
    assert(cmd_sd("sd read 1"));
    assert(sd_read_busy());

    output[0] = 0;
    assert(cmd_sd("sd probe") && strstr(output, "sd refused: read in progress") && strstr(output, "sd_end: 1"));
    output[0] = 0;
    assert(cmd_sd("sd status") && strstr(output, "sd refused: read in progress") && strstr(output, "sd_end: 1"));
    output[0] = 0;
    assert(cmd_sd("sd read 2") && strstr(output, "sd_data_error: read in progress") && strstr(output, "sd_data_end: 1"));

    /* Finish the read */
    for (unsigned i = 0; i < 10000 && sd_read_busy(); i++) { now += 10; sd_cli_poll(); }

    /* 6. Cancel while read in progress */
    drive_probe_done();
    output[0] = 0;
    assert(cmd_sd("sd read 2"));
    assert(sd_read_busy());
    output[0] = 0;
    assert(cmd_sd("sd cancel"));
    assert(!sd_read_busy());
    assert(cli_sd.phase == SD_PROBE_CANCELLED);
    assert(strstr(output, "sd_state: cancelled"));

    /* Attempt read after cancel without probe -> rejected */
    output[0] = 0;
    assert(cmd_sd("sd read 2"));
    assert(strstr(output, "sd_data_error: card not probed or not ready"));

    /* 7. Guard violation while read in progress (armed midway) */
    drive_probe_done();
    output[0] = 0;
    assert(cmd_sd("sd read 3"));
    assert(sd_read_busy());
    armed = true;
    output[0] = 0;
    sd_cli_poll();
    assert(!sd_read_busy());
    assert(cli_sd.phase == SD_PROBE_CANCELLED);
    assert(strstr(output, "sd_data_error: guard check failed"));
    assert(strstr(output, "sd_data_end: 1"));
    armed = false;

    /* 8. Verify ZERO write commands were issued to card during all tests */
    assert(g_mock.write_commands == 0);

    armed=bench=cal=bl_pending=false;usb=true;drive_probe_done();output[0]=0;
    assert(cmd_sd("sd read 0")&&sd_read_busy());now+=3000001;sd_cli_poll();
    assert(!sd_read_busy()&&cli_sd.phase==SD_PROBE_CANCELLED&&strstr(output,"sd_data_error:"));
    assert(!g_mock.write_commands);
    puts("PASS SD READ CLI: content/CRC/framing, malformed sector parsing, bounds, guards, cancel/re-probe, zero write commands");
    return 0;
}
