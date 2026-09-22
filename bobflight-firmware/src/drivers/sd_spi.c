/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * @file sd_spi.c
 * @brief Non-blocking SD Card SPI Mode State Machine Implementation
 */

#include <stdio.h>
#include "sd_spi.h"

/* --- Helper CRC Functions --- */

uint8_t sd_crc7(const uint8_t *data, size_t len) {
    uint8_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t b = data[i];
        for (int j = 0; j < 8; j++) {
            crc <<= 1;
            if ((b ^ crc) & 0x80) {
                crc ^= 0x09;
            }
            b <<= 1;
        }
    }
    return crc & 0x7F;
}

static uint16_t crc16_byte(uint16_t crc,uint8_t byte){
    crc^=(uint16_t)byte<<8;
    for(unsigned bit=0;bit<8;bit++)crc=(crc&0x8000u)?(uint16_t)((crc<<1)^0x1021u):(uint16_t)(crc<<1);
    return crc;
}
uint16_t sd_crc16(const uint8_t *data,size_t len){
    uint16_t crc=0;for(size_t i=0;i<len;i++)crc=crc16_byte(crc,data[i]);return crc;
}

/* --- Internal Helpers --- */

static void set_cs(sd_spi_t *sd, bool assert_cs) {
    if (sd->io.cs_select) {
        sd->io.cs_select(assert_cs, sd->io.user_ctx);
    }
    sd->cs_asserted = assert_cs;
}

static void prepare_cmd(sd_spi_t *sd, uint8_t cmd_index, uint32_t arg) {
    sd->cmd_buf[0] = 0xFF; /* At least eight idle clocks before command. */
    sd->cmd_buf[1] = 0x40 | (cmd_index & 0x3F);
    sd->cmd_buf[2] = (uint8_t)(arg >> 24);
    sd->cmd_buf[3] = (uint8_t)(arg >> 16);
    sd->cmd_buf[4] = (uint8_t)(arg >> 8);
    sd->cmd_buf[5] = (uint8_t)arg;
    sd->cmd_buf[6] = (sd_crc7(sd->cmd_buf+1,5)<<1)|1;
    sd->cmd_idx = 0;
}

static void transition_error(sd_spi_t *sd, sd_spi_status_t err) {
    sd->state = SD_SPI_STATE_ERROR;
    sd->substate = SUB_IDLE;
    sd->last_error = err;
    sd->io_active = false;
    if (sd->cs_asserted) {
        set_cs(sd, false);
    }
}

/* --- API Implementation --- */

void sd_spi_init_ctx(sd_spi_t *sd, const sd_spi_io_t *io) {
    if (!sd) return;

    *sd=(sd_spi_t){0};
    if (io) {
        sd->io = *io;
    } else {
        sd->io = (sd_spi_io_t){0};
    }

    sd->state = SD_SPI_STATE_UNINITIALIZED;
    sd->substate = SUB_IDLE;
    sd->last_error = SD_SPI_OK;
    sd->io_active = false;
    sd->cs_asserted = false;
    sd->data_buf = NULL;
    sd->target_sector = 0;

    sd->card_info = (sd_spi_card_info_t){0};
}

sd_spi_status_t sd_spi_begin_init(sd_spi_t *sd, uint64_t now_us) {
    if (!sd) return SD_SPI_ERR_INVALID_ARG;
    if (!sd->io.cs_select || !sd->io.set_speed || !sd->io.spi_start_exchange || !sd->io.spi_poll_exchange) {
        return SD_SPI_ERR_INVALID_ARG;
    }

    /* Refuse if already busy or reading/writing */
    if (sd->state == SD_SPI_STATE_INITIALIZING ||
        sd->state == SD_SPI_STATE_READING ||
        sd->state == SD_SPI_STATE_WRITING) {
        return SD_SPI_ERR_BUSY;
    }

    sd->state = SD_SPI_STATE_INITIALIZING;
    sd->substate = SUB_INIT_POWER_CLOCKS;
    sd->last_error = SD_SPI_OK;
    sd->op_start_us = now_us;
    sd->step_start_us = now_us;
    sd->data_idx = 0;
    sd->io_active = false;

    if (sd->io.set_speed) {
        sd->io.set_speed(SD_SPI_SPEED_SLOW, sd->io.user_ctx);
    }

    set_cs(sd, false);
    return SD_SPI_OK;
}

sd_spi_status_t sd_spi_begin_read(sd_spi_t *sd, uint32_t sector, uint8_t *buffer, uint64_t now_us) {
    if (!sd || !buffer) return SD_SPI_ERR_INVALID_ARG;

    if (sd->state != SD_SPI_STATE_READY) {
        return SD_SPI_ERR_NOT_READY;
    }

    if (sector >= sd->card_info.capacity_sectors) {
        return SD_SPI_ERR_OUT_OF_BOUNDS;
    }

    sd->state = SD_SPI_STATE_READING;
    sd->target_sector = sector;
    sd->data_buf = buffer;
    sd->substate = SUB_READ_CMD17_SEND;
    sd->op_start_us = now_us;
    sd->step_start_us = now_us;
    sd->io_active = false;

    set_cs(sd,true);
    sd->expected_crc16=0;
    prepare_cmd(sd, 17, sector);
    return SD_SPI_OK;
}

sd_spi_status_t sd_spi_begin_write(sd_spi_t *sd, uint32_t sector, const uint8_t *buffer, uint64_t now_us) {
    if (!sd || !buffer) return SD_SPI_ERR_INVALID_ARG;

    if (sd->state != SD_SPI_STATE_READY) {
        return SD_SPI_ERR_NOT_READY;
    }

    if (sector >= sd->card_info.capacity_sectors) {
        return SD_SPI_ERR_OUT_OF_BOUNDS;
    }

    sd->state = SD_SPI_STATE_WRITING;
    sd->target_sector = sector;
    sd->data_buf = (uint8_t *)buffer;
    sd->substate = SUB_WRITE_CMD24_SEND;
    sd->op_start_us = now_us;
    sd->step_start_us = now_us;
    sd->io_active = false;

    set_cs(sd,true);
    sd->expected_crc16=0;
    prepare_cmd(sd, 24, sector);
    return SD_SPI_OK;
}

sd_spi_status_t sd_poll(sd_spi_t *sd, uint64_t now_us) {
    if (!sd) return SD_SPI_ERR_INVALID_ARG;

    if (sd->state == SD_SPI_STATE_READY) {
        return SD_SPI_OK;
    }
    if (sd->state == SD_SPI_STATE_ERROR) {
        return sd->last_error != SD_SPI_OK ? sd->last_error : SD_SPI_ERR_NOT_READY;
    }
    if (sd->state == SD_SPI_STATE_UNINITIALIZED) {
        return SD_SPI_ERR_NOT_READY;
    }

    /* Check overall operation timeout (2 seconds) */
    if (now_us < sd->op_start_us || now_us - sd->op_start_us > 2000000ULL) {
        transition_error(sd, SD_SPI_ERR_TIMEOUT);
        return SD_SPI_ERR_TIMEOUT;
    }

    uint8_t rx_byte = 0xFF;

    /* 1. If an IO exchange is currently in progress, poll its status */
    if (sd->io_active) {
        sd_spi_io_status_t io_st = sd->io.spi_poll_exchange(&rx_byte, sd->io.user_ctx);
        if (io_st == SD_SPI_IO_PENDING) {
            return SD_SPI_ERR_BUSY;
        }
        if (io_st == SD_SPI_IO_ERROR) {
            transition_error(sd, SD_SPI_ERR_HARDWARE);
            return SD_SPI_ERR_HARDWARE;
        }
        sd->io_active = false; /* Transfer completed (SD_SPI_IO_DONE) */
    }

    /* 2. Process state machine with completed rx_byte or start next single byte exchange */
    switch (sd->substate) {

    /* --- INITIALIZATION --- */

    case SUB_INIT_POWER_CLOCKS:
        if (sd->data_idx < 10) {
            sd->data_idx++;
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        /* 10 dummy bytes sent with CS high */
        set_cs(sd, true);
        prepare_cmd(sd, 0, 0); /* CMD0 */
        sd->substate = SUB_INIT_CMD0_SEND;
        sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD0_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_CMD0_RESP;
        sd->ncr_attempts = 0;
        sd->step_start_us = now_us;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD0_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x01) { /* Idle state */
                set_cs(sd, false);
                set_cs(sd, true);
                prepare_cmd(sd, 8, 0x000001AA); /* CMD8 */
                sd->substate = SUB_INIT_CMD8_SEND;
                sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64 || (now_us - sd->step_start_us > 100000)) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD8_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_CMD8_RESP;
        sd->ncr_attempts = 0;
        sd->step_start_us = now_us;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD8_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x01) {
                sd->resp_idx = 0;
                sd->substate = SUB_INIT_CMD8_DATA;
                sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else { /* Standard capacity / unsupported card */
                transition_error(sd, SD_SPI_ERR_UNSUPPORTED);
                return SD_SPI_ERR_UNSUPPORTED;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64 || (now_us - sd->step_start_us > 100000)) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD8_DATA:
        sd->resp_buf[sd->resp_idx++] = rx_byte;
        if (sd->resp_idx < 4) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        /* Verify voltage check (0x01) and echo pattern (0xAA) */
        if (sd->resp_buf[2] != 0x01 || sd->resp_buf[3] != 0xAA) {
            transition_error(sd, SD_SPI_ERR_UNSUPPORTED);
            return SD_SPI_ERR_UNSUPPORTED;
        }
        set_cs(sd, false);
        sd->substate = SUB_INIT_ACMD41_LOOP;
        sd->step_start_us = now_us;
        /* Start ACMD41 loop */
        set_cs(sd, true);
        prepare_cmd(sd, 55, 0); /* CMD55 */
        sd->substate = SUB_INIT_CMD55_SEND;
        sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_ACMD41_LOOP:
        if (now_us - sd->step_start_us > 1000000ULL) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        set_cs(sd, true);
        prepare_cmd(sd, 55, 0); /* CMD55 */
        sd->substate = SUB_INIT_CMD55_SEND;
        sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD55_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_CMD55_RESP;
        sd->ncr_attempts = 0;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD55_RESP:
        if ((rx_byte & 0x80) == 0) {
            set_cs(sd, false);
            set_cs(sd, true);
            prepare_cmd(sd, 41, 0x40000000); /* ACMD41 with HCS = 1 */
            sd->substate = SUB_INIT_ACMD41_SEND;
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_ACMD41_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_ACMD41_RESP;
        sd->ncr_attempts = 0;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_ACMD41_RESP:
        if ((rx_byte & 0x80) == 0) {
            set_cs(sd, false);
            if (rx_byte == 0x00) { /* Card is ready! */
                set_cs(sd, true);
                prepare_cmd(sd, 58, 0); /* CMD58 READ_OCR */
                sd->substate = SUB_INIT_CMD58_SEND;
                sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else if (rx_byte == 0x01) { /* Still idle, repeat ACMD41 loop */
                sd->substate = SUB_INIT_ACMD41_LOOP;
                return sd_poll(sd, now_us);
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD58_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_CMD58_RESP;
        sd->ncr_attempts = 0;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD58_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x00) {
                sd->resp_idx = 0;
                sd->substate = SUB_INIT_CMD58_DATA;
                sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD58_DATA:
        sd->card_info.ocr[sd->resp_idx++] = rx_byte;
        if (sd->resp_idx < 4) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        /* Require power-up complete, SDHC/SDXC and compatibility with the
         * target slot's 3.3V supply. No 1.8V signaling negotiation is performed. */
        if ((sd->card_info.ocr[0] & 0xC0) != 0xC0 || (sd->card_info.ocr[1] & 0x30) == 0) {
            /* Fail closed for unsupported capacity/voltage state. */
            transition_error(sd, SD_SPI_ERR_UNSUPPORTED);
            return SD_SPI_ERR_UNSUPPORTED;
        }
        set_cs(sd, false);
        sd->substate = SUB_INIT_SWITCH_SPEED;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_SWITCH_SPEED:
        if (sd->io.set_speed) {
            sd->io.set_speed(SD_SPI_SPEED_FAST, sd->io.user_ctx);
        }
        set_cs(sd, true);
        prepare_cmd(sd, 9, 0); /* CMD9 SEND_CSD */
        sd->substate = SUB_INIT_CMD9_SEND;
        sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD9_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_INIT_CMD9_RESP;
        sd->ncr_attempts = 0;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CMD9_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x00) {
                sd->substate = SUB_INIT_CSD_WAIT_TOKEN;
                sd->step_start_us = now_us;
                sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CSD_WAIT_TOKEN:
        if (rx_byte == 0xFE) {
            sd->resp_idx = 0;
            sd->substate = SUB_INIT_CSD_READ_DATA;
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        if (now_us - sd->step_start_us > 100000) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CSD_READ_DATA:
        sd->card_info.csd[sd->resp_idx++] = rx_byte;
        if (sd->resp_idx < 16) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->resp_idx = 0;
        sd->substate = SUB_INIT_CSD_READ_CRC;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_CSD_READ_CRC:
        sd->resp_buf[sd->resp_idx++] = rx_byte;
        if (sd->resp_idx < 2) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        if(sd_crc16(sd->card_info.csd,16)!=((uint16_t)sd->resp_buf[0]<<8|sd->resp_buf[1])){
            transition_error(sd,SD_SPI_ERR_CRC);return SD_SPI_ERR_CRC;
        }
        /* Parse CSDv2 structure */
        uint8_t csd_ver = (sd->card_info.csd[0] >> 6) & 0x03;
        if (csd_ver != 1) { /* CSD version 2.0 has CSD_STRUCTURE == 1 */
            transition_error(sd, SD_SPI_ERR_UNSUPPORTED);
            return SD_SPI_ERR_UNSUPPORTED;
        }
        uint32_t c_size = ((uint32_t)(sd->card_info.csd[7] & 0x3F) << 16) |
                          ((uint32_t)sd->card_info.csd[8] << 8) |
                           (uint32_t)sd->card_info.csd[9];
        sd->card_info.c_size = c_size;
        sd->card_info.capacity_sectors = ((uint64_t)c_size + 1u) * 1024u;
        sd->card_info.capacity_bytes = (uint64_t)sd->card_info.capacity_sectors * 512ULL;

        set_cs(sd, false);
        sd->substate = SUB_INIT_FINISH;
        sd->io.spi_start_exchange(0xFF,sd->io.user_ctx);sd->io_active=true;
        return SD_SPI_ERR_BUSY;

    case SUB_INIT_FINISH:
        sd->state = SD_SPI_STATE_READY;
        sd->substate = SUB_IDLE;
        sd->last_error = SD_SPI_OK;
        return SD_SPI_OK;

    /* --- READ SINGLE BLOCK (CMD17) --- */

    case SUB_READ_CMD17_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_READ_CMD17_RESP;
        sd->ncr_attempts = 0;
        sd->step_start_us = now_us;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_READ_CMD17_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x00) {
                sd->substate = SUB_READ_WAIT_TOKEN;
                sd->step_start_us = now_us;
                sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64 || (now_us - sd->step_start_us > 100000)) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_READ_WAIT_TOKEN:
        if (rx_byte == 0xFE) { /* Start Data Token */
            sd->data_idx = 0;
            sd->substate = SUB_READ_DATA_BYTES;
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        if ((rx_byte & 0xE0) == 0) { /* Data error token bit */
            transition_error(sd, SD_SPI_ERR_HARDWARE);
            return SD_SPI_ERR_HARDWARE;
        }
        if (now_us - sd->step_start_us > 100000) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_READ_DATA_BYTES:
        sd->data_buf[sd->data_idx++] = rx_byte;
        sd->expected_crc16=crc16_byte(sd->expected_crc16,rx_byte);
        if (sd->data_idx < 512) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->resp_idx = 0;
        sd->substate = SUB_READ_CRC16;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_READ_CRC16:
        sd->resp_buf[sd->resp_idx++] = rx_byte;
        if (sd->resp_idx < 2) {
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->rx_crc16 = ((uint16_t)sd->resp_buf[0] << 8) | sd->resp_buf[1];

        if (sd->rx_crc16 != sd->expected_crc16) {
            transition_error(sd, SD_SPI_ERR_CRC);
            return SD_SPI_ERR_CRC;
        }
        set_cs(sd, false);
        sd->substate = SUB_READ_FINISH;
        sd->io.spi_start_exchange(0xFF,sd->io.user_ctx);sd->io_active=true;
        return SD_SPI_ERR_BUSY;

    case SUB_READ_FINISH:
        sd->state = SD_SPI_STATE_READY;
        sd->substate = SUB_IDLE;
        sd->last_error = SD_SPI_OK;
        return SD_SPI_OK;

    /* --- WRITE SINGLE BLOCK (CMD24) --- */

    case SUB_WRITE_CMD24_SEND:
        if (sd->cmd_idx < 7) {
            sd->io.spi_start_exchange(sd->cmd_buf[sd->cmd_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        sd->substate = SUB_WRITE_CMD24_RESP;
        sd->ncr_attempts = 0;
        sd->step_start_us = now_us;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_CMD24_RESP:
        if ((rx_byte & 0x80) == 0) {
            if (rx_byte == 0x00) {
                sd->substate = SUB_WRITE_GAP_BYTE;
                sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
                sd->io_active = true;
                return SD_SPI_ERR_BUSY;
            } else {
                transition_error(sd, SD_SPI_ERR_HARDWARE);
                return SD_SPI_ERR_HARDWARE;
            }
        }
        sd->ncr_attempts++;
        if (sd->ncr_attempts > 64 || (now_us - sd->step_start_us > 100000)) {
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_GAP_BYTE:
        /* Gap byte transmitted, now send Start Data Token 0xFE */
        sd->substate = SUB_WRITE_TOKEN;
        sd->data_idx = 0;
        sd->io.spi_start_exchange(0xFE, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_TOKEN:
        /* Token transmitted, now send data bytes */
        sd->substate = SUB_WRITE_DATA_BYTES;
        sd->expected_crc16=crc16_byte(sd->expected_crc16,sd->data_buf[sd->data_idx]);
        sd->io.spi_start_exchange(sd->data_buf[sd->data_idx++], sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_DATA_BYTES:
        if (sd->data_idx < 512) {
            sd->expected_crc16=crc16_byte(sd->expected_crc16,sd->data_buf[sd->data_idx]);
        sd->io.spi_start_exchange(sd->data_buf[sd->data_idx++], sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        /* All 512 bytes sent. Compute CRC16 and send 2 bytes CRC16 */

        sd->substate = SUB_WRITE_CRC16_SEND;
        sd->resp_idx = 0;
        sd->io.spi_start_exchange((uint8_t)(sd->expected_crc16 >> 8), sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_CRC16_SEND:
        if (sd->resp_idx == 0) {
            sd->resp_idx = 1;
            sd->io.spi_start_exchange((uint8_t)(sd->expected_crc16), sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        }
        /* Both CRC bytes sent. Now read Data Response Byte */
        sd->substate = SUB_WRITE_RESP;
        sd->step_start_us=now_us;sd->ncr_attempts=0;
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_RESP:
        /* A delayed response is not a rejection; clock it with bounded polls. */
        if(rx_byte==0xFF){
            if(++sd->ncr_attempts>64u||now_us-sd->step_start_us>100000u){transition_error(sd,SD_SPI_ERR_TIMEOUT);return SD_SPI_ERR_TIMEOUT;}
            sd->io.spi_start_exchange(0xFF,sd->io.user_ctx);sd->io_active=true;return SD_SPI_ERR_BUSY;
        }
        /* Data response byte received */
        uint8_t status = rx_byte & 0x1F;
        if (status == 0x05) { /* Data accepted */
            sd->substate = SUB_WRITE_BUSY_WAIT;
            sd->step_start_us = now_us;
            sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
            sd->io_active = true;
            return SD_SPI_ERR_BUSY;
        } else if (status == 0x0B) { /* CRC error reject */
            transition_error(sd, SD_SPI_ERR_CRC);
            return SD_SPI_ERR_CRC;
        } else { /* Write error / reject */
            transition_error(sd, SD_SPI_ERR_REJECTED);
            return SD_SPI_ERR_REJECTED;
        }

    case SUB_WRITE_BUSY_WAIT:
        if (rx_byte == 0xFF) { /* Card finished writing flash */
            set_cs(sd, false);sd->substate=SUB_WRITE_FINISH;
            sd->io.spi_start_exchange(0xFF,sd->io.user_ctx);sd->io_active=true;
            return SD_SPI_ERR_BUSY;
        }
        if (now_us - sd->step_start_us > 500000ULL) { /* 500 ms write timeout */
            transition_error(sd, SD_SPI_ERR_TIMEOUT);
            return SD_SPI_ERR_TIMEOUT;
        }
        sd->io.spi_start_exchange(0xFF, sd->io.user_ctx);
        sd->io_active = true;
        return SD_SPI_ERR_BUSY;

    case SUB_WRITE_FINISH:
        sd->state=SD_SPI_STATE_READY;sd->substate=SUB_IDLE;sd->last_error=SD_SPI_OK;return SD_SPI_OK;
    default:
        transition_error(sd, SD_SPI_ERR_HARDWARE);
        return SD_SPI_ERR_HARDWARE;
    }
}

sd_spi_state_t sd_spi_get_state(const sd_spi_t *sd) {
    return sd ? sd->state : SD_SPI_STATE_UNINITIALIZED;
}

const sd_spi_card_info_t *sd_spi_get_card_info(const sd_spi_t *sd) {
    return sd ? &sd->card_info : NULL;
}

sd_spi_status_t sd_spi_get_last_error(const sd_spi_t *sd) {
    return sd ? sd->last_error : SD_SPI_ERR_INVALID_ARG;
}
