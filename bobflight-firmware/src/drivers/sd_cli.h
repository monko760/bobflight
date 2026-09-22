/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SD_CLI_H
#define BOBFLIGHT_SD_CLI_H

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>

#if defined(BOBFLIGHT_MCU)
static bool blackbox_cli_busy(void);
#endif

#if defined(BOBFLIGHT_MCU) || defined(BOBFLIGHT_SD_CLI_TEST)
#include "drivers/sd_probe.h"
#include "hal/stm32f7/sd_spi_hw.h"

static sd_probe_t cli_sd;
static uint8_t sd_cli_read_buf[512];
static bool sd_cli_read_active = false;
static uint32_t sd_cli_read_sector = 0;
static uint64_t sd_cli_read_started;

static inline bool sd_read_busy(void) {
    return sd_cli_read_active;
}

static inline bool sd_cli_guard(void) {
    return arming_state() != ARM_ARMED && !bench_motor_active() &&
           !gyro_manual_calibration_active() && hal_usb_cdc_connected() && !bl_pending;
}

static inline uint32_t sd_cli_crc32(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1u));
        }
    }
    return ~crc;
}

static void sd_cli_poll(void) {
    if (sd_cli_read_active) {
        uint64_t start_us = hal_micros();
        for (int i = 0; i < 16; i++) {
            if (!sd_cli_guard() || hal_micros()<sd_cli_read_started || hal_micros()-sd_cli_read_started>3000000u
#if defined(BOBFLIGHT_MCU)
                || blackbox_cli_busy()
#endif
            ) {
                sd_spi_hw_cancel();
                sd_cli_read_active = false;
                cli_sd.phase = SD_PROBE_CANCELLED;
                cli_write_str("sd_data_error: guard check failed\r\nsd_data_end: 1\r\n");
                return;
            }
            uint64_t now_us = hal_micros();
            if (i > 0 && (now_us - start_us) >= 8) {
                break;
            }
            sd_spi_status_t st = sd_poll(&cli_sd.card, now_us);
            if (cli_sd.card.state == SD_SPI_STATE_READY) {
                sd_cli_read_active = false;
                char header[128];
                snprintf(header, sizeof(header), "sd_data_api: 1\r\nsd_data_sector: %lu\r\nsd_data_hex: ", (unsigned long)sd_cli_read_sector);
                cli_write_str(header);

                char hex[1025];
                for (int b = 0; b < 512; b++) {
                    static const char digits[]="0123456789ABCDEF";
                    hex[b*2]=digits[sd_cli_read_buf[b]>>4];hex[b*2+1]=digits[sd_cli_read_buf[b]&15];
                }
                hex[1024] = '\0';
                cli_write_str(hex);

                uint32_t crc = sd_cli_crc32(sd_cli_read_buf, 512);
                char footer[64];
                snprintf(footer, sizeof(footer), "\r\nsd_data_crc32: %08X\r\nsd_data_end: 1\r\n", (unsigned)crc);
                cli_write_str(footer);
                return;
            }
            if (st != SD_SPI_OK && st != SD_SPI_ERR_BUSY) {
                sd_spi_hw_cancel();
                sd_cli_read_active = false;
                cli_sd.phase = SD_PROBE_ERROR;
                cli_write_str("sd_data_error: driver error\r\nsd_data_end: 1\r\n");
                return;
            }
        }
        return;
    }

    if (!sd_probe_busy(&cli_sd)) return;
    if (!sd_cli_guard()) { sd_probe_cancel(&cli_sd); sd_spi_hw_cancel(); return; }
    sd_probe_poll(&cli_sd, hal_micros());
    if (cli_sd.phase == SD_PROBE_ERROR) sd_spi_hw_cancel();
}

static void sd_cli_status(void) {
    static const char *states[] = {"idle", "initializing", "reading-mbr", "reading-boot-sector", "done", "error", "cancelled"};
    char out[512];
    snprintf(out, sizeof out, "sd_api: 1\r\nsd_state: %s\r\nsd_detail: %s\r\nsd_capacity_bytes: %llu\r\nsd_sectors: %llu\r\nsd_partition_lba: %lu\r\nsd_filesystem_hint: %s\r\nsd_cluster_bytes: %lu\r\nsd_volume_flags: %u\r\nsd_io_error: %u\r\nsd_write_enabled: no\r\nsd_filesystem_validated: no\r\nsd_end: 1\r\n",
        states[cli_sd.phase], cli_sd.detail ? cli_sd.detail : "not-probed", (unsigned long long)cli_sd.card.card_info.capacity_bytes, (unsigned long long)cli_sd.card.card_info.capacity_sectors, (unsigned long)cli_sd.partition_lba, cli_sd.filesystem ? cli_sd.filesystem : "unknown", (unsigned long)cli_sd.cluster_bytes, cli_sd.volume_flags, (unsigned)cli_sd.card.last_error);
    cli_write_str(out);
}

static inline bool sd_parse_sector(const char *str, uint32_t *out_sector) {
    if (!str || !*str) return false;
    if (str[0] == '0' && str[1] != '\0') return false; /* No leading zeros unless single '0' */
    uint64_t val = 0;
    for (size_t i = 0; str[i] != '\0'; i++) {
        if (!isdigit((unsigned char)str[i])) return false;
        val = val * 10u + (uint64_t)(str[i] - '0');
        if (val > 0xFFFFFFFFu) return false;
    }
    *out_sector = (uint32_t)val;
    return true;
}

static bool cmd_sd(const char *line) {
    bool is_read = (strncmp(line, "sd read", 7) == 0 && (line[7] == '\0' || line[7] == ' '));
    if (strcmp(line, "sd probe") && strcmp(line, "sd status") && strcmp(line, "sd cancel") && !is_read) return false;

#if defined(BOBFLIGHT_MCU)
    if (blackbox_cli_busy()) {
        cli_write_str(is_read ? "sd_data_error: blackbox busy\r\nsd_data_end: 1\r\n" : "sd unavailable: Blackbox recording owns the card; stop and wait for done\r\nsd_end: 1\r\n");
        return true;
    }
#endif
    if (sd_cli_read_active) {
        if (!strcmp(line, "sd cancel")) {
            sd_probe_cancel(&cli_sd);
            sd_spi_hw_cancel();
            sd_cli_read_active = false;
            cli_sd.phase = SD_PROBE_CANCELLED;
            sd_cli_status();
            return true;
        }
        if (is_read) {
            cli_write_str("sd_data_error: read in progress\r\nsd_data_end: 1\r\n");
            return true;
        }
        cli_write_str("sd refused: read in progress\r\nsd_end: 1\r\n");
        return true;
    }

    if (!strcmp(line, "sd cancel")) {
        sd_probe_cancel(&cli_sd);
        sd_spi_hw_cancel();
        sd_cli_status();
        return true;
    }

    if (is_read) {
#if defined(BOBFLIGHT_MCU)
        if (blackbox_cli_busy()) {
            cli_write_str("sd_data_error: blackbox busy\r\nsd_data_end: 1\r\n");
            return true;
        }
#endif
        if (!sd_cli_guard()) {
            cli_write_str("sd_data_error: disarm, stop motor tests/calibration, connect USB required\r\nsd_data_end: 1\r\n");
            return true;
        }
        if (cli_sd.phase != SD_PROBE_DONE || cli_sd.card.state != SD_SPI_STATE_READY) {
            cli_write_str("sd_data_error: card not probed or not ready\r\nsd_data_end: 1\r\n");
            return true;
        }
        if (line[7] != ' ') {
            cli_write_str("sd_data_error: malformed sector argument\r\nsd_data_end: 1\r\n");
            return true;
        }
        uint32_t sector = 0;
        if (!sd_parse_sector(line + 8, &sector)) {
            cli_write_str("sd_data_error: malformed sector argument\r\nsd_data_end: 1\r\n");
            return true;
        }
        if (sector >= cli_sd.card.card_info.capacity_sectors) {
            cli_write_str("sd_data_error: sector out of bounds\r\nsd_data_end: 1\r\n");
            return true;
        }
        sd_spi_status_t st = sd_spi_begin_read(&cli_sd.card, sector, sd_cli_read_buf, hal_micros());
        if (st != SD_SPI_OK) {
            cli_write_str("sd_data_error: begin read failed\r\nsd_data_end: 1\r\n");
            return true;
        }
        sd_cli_read_active = true;
        sd_cli_read_started=hal_micros();
        sd_cli_read_sector = sector;
        return true;
    }

#if defined(BOBFLIGHT_MCU)
    if (blackbox_cli_busy()) {
        cli_write_str("sd unavailable: Blackbox recording owns the card; stop and wait for done\r\nsd_end: 1\r\n");
        return true;
    }
#endif

    if (!strcmp(line, "sd probe")) {
        if (!sd_cli_guard() || sd_probe_busy(&cli_sd)) {
            cli_write_str("sd refused: disarm, stop motor tests/calibration, connect USB, and wait or cancel the current probe\r\nsd_end: 1\r\n");
            return true;
        }
        sd_spi_io_t io;
        sd_spi_hw_cancel();
        if (!sd_spi_hw_bind(&io)) {
            cli_write_str("sd unavailable: unsupported board, clock or pin configuration\r\nsd_end: 1\r\n");
            return true;
        }
        if (!sd_probe_start(&cli_sd, &io, hal_micros())) sd_spi_hw_cancel();
    }
    sd_cli_status();
    return true;
}

#else

static void sd_cli_poll(void) {}
static inline bool sd_read_busy(void) { return false; }
static bool cmd_sd(const char *line) {
    if (strcmp(line, "sd probe") && strcmp(line, "sd status") && strcmp(line, "sd cancel") && strncmp(line, "sd read", 7)) return false;
    if(!strncmp(line,"sd read",7)){cli_write_str("sd_data_error: no hardware backend in host simulation\r\nsd_data_end: 1\r\n");return true;}
    cli_write_str("sd unavailable: no hardware backend in host simulation\r\nsd_write_enabled: no\r\nsd_end: 1\r\n");
    return true;
}

#endif

#endif /* BOBFLIGHT_SD_CLI_H */
