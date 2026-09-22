/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * @file test_sd_spi.c
 * @brief Standalone Mock Unit Tests for SD Card SPI State Machine
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

#include "drivers/sd_spi.h"

/* --- Mock Card Configuration & State --- */

typedef enum {
    MOCK_CARD_SDHC_64GB = 0,
    MOCK_CARD_SDSC,          /* Standard capacity (CCS = 0) */
    MOCK_CARD_READ_BAD_CRC,  /* Corrupts read CRC16 */
    MOCK_CARD_WRITE_REJECT,  /* Rejects data write (0x0B status) */
    MOCK_CARD_WRITE_DELAY,
    MOCK_CARD_CSD_BAD_CRC,
    MOCK_CARD_CSD_MAX,
    MOCK_CARD_UNRESPONSIVE   /* Ignores commands / times out */
} mock_card_type_t;

typedef struct {
    mock_card_type_t type;
    unsigned write_commands;
    uint8_t memory[16][512]; /* Mock storage for 16 sectors */

    /* SPI bus state */
    bool cs_asserted;
    sd_spi_speed_t current_speed;

    /* Single byte exchange register */
    uint8_t last_tx_byte;
    uint8_t pending_rx_byte;
    bool io_pending;

    /* Command receiver state */
    uint8_t rx_cmd_buf[6];
    uint8_t rx_cmd_count;

    /* Response / Data output FIFO */
    uint8_t tx_fifo[1024];
    uint16_t tx_fifo_head;
    uint16_t tx_fifo_tail;

    /* Data input receiver (for write CMD24) */
    uint8_t write_buf[512];
    uint16_t write_count;
    bool write_token_seen;
    uint16_t write_crc;
    uint32_t active_write_sector;
    bool receiving_write_data;
    uint8_t write_busy_cycles;

    /* Stats for bounded callback verification */
    uint32_t max_calls_per_poll;
    uint32_t current_poll_calls;
} mock_card_t;

static mock_card_t g_mock;

static void fifo_push(uint8_t b) {
    if (g_mock.tx_fifo_tail < sizeof(g_mock.tx_fifo)) {
        g_mock.tx_fifo[g_mock.tx_fifo_tail++] = b;
    }
}

static uint8_t fifo_pop(void) {
    if (g_mock.tx_fifo_head < g_mock.tx_fifo_tail) {
        return g_mock.tx_fifo[g_mock.tx_fifo_head++];
    }
    return 0xFF; /* Default bus high */
}

static void fifo_clear(void) {
    g_mock.tx_fifo_head = 0;
    g_mock.tx_fifo_tail = 0;
}

/* --- Mock IO Callbacks --- */

static void mock_cs_select(bool assert_cs, void *user_ctx) {
    (void)user_ctx;
    g_mock.current_poll_calls++;
    g_mock.cs_asserted = assert_cs;
    if (!assert_cs) {
        /* CS deasserted -> clear command receiver state */
        g_mock.rx_cmd_count = 0;
    }
}

static void mock_set_speed(sd_spi_speed_t speed, void *user_ctx) {
    (void)user_ctx;
    g_mock.current_poll_calls++;
    g_mock.current_speed = speed;
}

static void process_mock_cmd(void) {
    uint8_t cmd_idx = g_mock.rx_cmd_buf[0] & 0x3F;
    uint32_t arg = ((uint32_t)g_mock.rx_cmd_buf[1] << 24) |
                   ((uint32_t)g_mock.rx_cmd_buf[2] << 16) |
                   ((uint32_t)g_mock.rx_cmd_buf[3] << 8)  |
                    (uint32_t)g_mock.rx_cmd_buf[4];

    assert(((sd_crc7(g_mock.rx_cmd_buf,5)<<1)|1)==g_mock.rx_cmd_buf[5]);
    fifo_clear();

    if (g_mock.type == MOCK_CARD_UNRESPONSIVE) {
        return; /* Send nothing, simulation will time out */
    }

    fifo_push(0xFF); /* NCR byte */

    switch (cmd_idx) {
    case 0: /* CMD0: GO_IDLE_STATE */
        fifo_push(0x01); /* R1: Idle state */
        break;

    case 8: /* CMD8: SEND_IF_COND */
        if (g_mock.type == MOCK_CARD_SDSC) {
            fifo_push(0x05); /* Illegal command on SDv1 / SDSC without CMD8 support */
        } else {
            fifo_push(0x01); /* R1: Idle state */
            fifo_push(0x00);
            fifo_push(0x00);
            fifo_push(0x01); /* Voltage accepted */
            fifo_push(0xAA); /* Echo pattern */
        }
        break;

    case 55: /* CMD55: APP_CMD */
        fifo_push(0x01); /* R1: Idle state */
        break;

    case 41: /* ACMD41: SD_SEND_OP_COND */
        fifo_push(0x00); /* R1: Ready (left idle state) */
        break;

    case 58: /* CMD58: READ_OCR */
        fifo_push(0x00); /* R1: Success */
        if (g_mock.type == MOCK_CARD_SDSC) {
            /* CCS = 0 (Standard Capacity) */
            fifo_push(0x80); fifo_push(0xFF); fifo_push(0x80); fifo_push(0x00);
        } else {
            /* CCS = 1 (High Capacity SDHC/SDXC) & Power up complete */
            fifo_push(0xC0); fifo_push(0xFF); fifo_push(0x80); fifo_push(0x00);
        }
        break;

    case 9: /* CMD9: SEND_CSD */
        fifo_push(0x00); /* R1: Success */
        fifo_push(0xFE); /* Data Start Token */

        /* 16-byte CSDv2 for 64GB SDXC (C_SIZE = 122070 = 0x01DCD6) */
        uint8_t csd[16] = {0};
        csd[0] = 0x40; /* CSD_STRUCTURE = 1 (CSDv2) */
        csd[7] = 0x01; /* C_SIZE upper bits */
        csd[8] = 0xDC; /* C_SIZE mid bits */
        csd[9] = 0xD6; /* C_SIZE lower bits */

        if(g_mock.type==MOCK_CARD_CSD_MAX){csd[7]=0x3f;csd[8]=0xff;csd[9]=0xff;}
        for (int i = 0; i < 16; i++) {
            fifo_push(csd[i]);
        }
        uint16_t csd_crc = sd_crc16(csd, 16);
        if(g_mock.type==MOCK_CARD_CSD_BAD_CRC)csd_crc^=1;
        fifo_push((uint8_t)(csd_crc >> 8));
        fifo_push((uint8_t)(csd_crc & 0xFF));
        break;

    case 17: /* CMD17: READ_SINGLE_BLOCK */
        fifo_push(0x00); /* R1: Success */
        fifo_push(0xFE); /* Data Start Token */

        uint32_t sector = arg;
        const uint8_t *sec_data = (sector < 16) ? g_mock.memory[sector] : g_mock.memory[0];

        for (int i = 0; i < 512; i++) {
            fifo_push(sec_data[i]);
        }

        uint16_t read_crc = sd_crc16(sec_data, 512);
        if (g_mock.type == MOCK_CARD_READ_BAD_CRC) {
            read_crc ^= 0xFFFF; /* Corrupt CRC16 */
        }
        fifo_push((uint8_t)(read_crc >> 8));
        fifo_push((uint8_t)(read_crc & 0xFF));
        break;

    case 24: /* CMD24: WRITE_BLOCK */
        g_mock.write_commands++;
        fifo_push(0x00); /* R1: Success */
        g_mock.active_write_sector = arg;
        g_mock.receiving_write_data = true;
        g_mock.write_count = 0;
        g_mock.write_token_seen=false;g_mock.write_crc=0;
        break;

    default:
        fifo_push(0x04); /* Illegal command */
        break;
    }
}

static void mock_start_exchange(uint8_t tx_byte, void *user_ctx) {
    (void)user_ctx;
    g_mock.current_poll_calls++;
    g_mock.last_tx_byte = tx_byte;
    g_mock.io_pending = true;

    if (!g_mock.cs_asserted) {
        g_mock.pending_rx_byte = 0xFF;
        return;
    }

    if (g_mock.receiving_write_data) {
        if(!g_mock.write_token_seen){
            /* Command response must drain before the host's data token. */
            g_mock.pending_rx_byte=fifo_pop();
            if(tx_byte==0xFE)g_mock.write_token_seen=true;
        }else if (g_mock.write_count < 512) {
            g_mock.write_buf[g_mock.write_count++] = tx_byte;
            g_mock.pending_rx_byte = 0xFF;
        } else if (g_mock.write_count < 514) {
            /* CRC bytes */
            g_mock.write_crc=(uint16_t)((g_mock.write_crc<<8)|tx_byte);
            g_mock.write_count++;
            g_mock.pending_rx_byte = 0xFF;
            if (g_mock.write_count == 514) {
                assert(g_mock.write_crc==sd_crc16(g_mock.write_buf,512));
                /* All data + CRC received. Send Data Response Byte */
                if (g_mock.type == MOCK_CARD_WRITE_REJECT) {
                    fifo_push(0x0B); /* Data rejected due to CRC error */
                } else {
                    if(g_mock.type==MOCK_CARD_WRITE_DELAY){for(unsigned delay=0;delay<4;delay++)fifo_push(0xFF);}
                    fifo_push(0x05); /* Data accepted */
                    /* Save to mock memory */
                    if (g_mock.active_write_sector < 16) {
                        memcpy(g_mock.memory[g_mock.active_write_sector], g_mock.write_buf, 512);
                    }
                    /* Add 2 busy bytes (0x00) before ready (0xFF) */
                    fifo_push(0x00);
                    fifo_push(0x00);
                }
                g_mock.receiving_write_data = false;
            }
        }
        return;
    }

    /* Standard command / response mode */
    if (g_mock.rx_cmd_count == 0) {
        if ((tx_byte & 0xC0) == 0x40) {
            g_mock.rx_cmd_buf[0] = tx_byte;
            g_mock.rx_cmd_count = 1;
            g_mock.pending_rx_byte = 0xFF;
        } else {
            g_mock.pending_rx_byte = fifo_pop();
        }
    } else {
        g_mock.rx_cmd_buf[g_mock.rx_cmd_count++] = tx_byte;
        if (g_mock.rx_cmd_count == 6) {
            process_mock_cmd();
            g_mock.rx_cmd_count = 0;
        }
        g_mock.pending_rx_byte = 0xFF;
    }
}

static sd_spi_io_status_t mock_poll_exchange(uint8_t *rx_byte, void *user_ctx) {
    (void)user_ctx;
    g_mock.current_poll_calls++;
    if (!g_mock.io_pending) {
        return SD_SPI_IO_PENDING;
    }
    g_mock.io_pending = false;
    if (rx_byte) {
        *rx_byte = g_mock.pending_rx_byte;
    }
    return SD_SPI_IO_DONE;
}

static sd_spi_io_t create_mock_io(void) {
    return (sd_spi_io_t){
        .cs_select = mock_cs_select,
        .set_speed = mock_set_speed,
        .spi_start_exchange = mock_start_exchange,
        .spi_poll_exchange = mock_poll_exchange,
        .user_ctx = NULL
    };
}

static void reset_mock_card(mock_card_type_t type) {
    memset(&g_mock, 0, sizeof(g_mock));
    g_mock.type = type;

    /* Initialize test patterns in mock memory */
    for (int s = 0; s < 16; s++) {
        for (int i = 0; i < 512; i++) {
            g_mock.memory[s][i] = (uint8_t)(s + i);
        }
    }
}

/* Helper to drive state machine to completion */
static sd_spi_status_t drive_sd_poll_until_done(sd_spi_t *sd, uint64_t *now_us, uint32_t max_polls) {
    sd_spi_status_t st = SD_SPI_ERR_BUSY;
    uint32_t polls = 0;

    while (st == SD_SPI_ERR_BUSY && polls < max_polls) {
        g_mock.current_poll_calls = 0;
        st = sd_poll(sd, *now_us);
        if (g_mock.current_poll_calls > g_mock.max_calls_per_poll) {
            g_mock.max_calls_per_poll = g_mock.current_poll_calls;
        }
        *now_us += 10; /* Advance clock by 10us */
        polls++;
    }
    return st;
}

/* --- Unit Tests --- */

static void test_init_high_capacity_success(void) {
    printf("[TEST] 1. Init high-capacity SDHC/SDXC 64GB card...\n");
    reset_mock_card(MOCK_CARD_SDHC_64GB);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_status_t st = sd_spi_begin_init(&sd, now_us);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_INITIALIZING);

    st = drive_sd_poll_until_done(&sd, &now_us, 2000);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_READY);

    const sd_spi_card_info_t *info = sd_spi_get_card_info(&sd);
    assert(info != NULL);
    assert(info->capacity_sectors == 125000704); /* 122071 * 1024 sectors */
    assert(info->capacity_bytes == 64000360448ULL);
    assert(g_mock.current_speed == SD_SPI_SPEED_FAST);
    printf("       -> PASS: Init success, 64GB parsed (%llu sectors, %llu bytes)\n",
           (unsigned long long)info->capacity_sectors, (unsigned long long)info->capacity_bytes);
}

static void test_init_sdsc_rejection(void) {
    printf("[TEST] 2. Init non-SDHC (standard capacity SDSC) card rejection...\n");
    reset_mock_card(MOCK_CARD_SDSC);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);

    sd_spi_status_t st = drive_sd_poll_until_done(&sd, &now_us, 2000);
    assert(st == SD_SPI_ERR_UNSUPPORTED);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_ERROR);
    printf("       -> PASS: Standard capacity card rejected as expected (CCS=0)\n");
}

static void test_read_success_and_crc(void) {
    printf("[TEST] 3. Read single block (512B) CMD17 success & CRC16 verification...\n");
    reset_mock_card(MOCK_CARD_SDHC_64GB);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);
    drive_sd_poll_until_done(&sd, &now_us, 2000);

    uint8_t read_buf[512] = {0};
    sd_spi_status_t st = sd_spi_begin_read(&sd, 3, read_buf, now_us);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_READING);

    st = drive_sd_poll_until_done(&sd, &now_us, 3000);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_READY);

    /* Verify data contents match mock memory for sector 3 */
    for (int i = 0; i < 512; i++) {
        assert(read_buf[i] == (uint8_t)(3 + i));
    }
    printf("       -> PASS: Read 512 bytes from sector 3 verified with matching CRC16\n");
}

static void test_read_bad_crc(void) {
    printf("[TEST] 4. Read single block bad CRC16 detection...\n");
    reset_mock_card(MOCK_CARD_READ_BAD_CRC);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);
    drive_sd_poll_until_done(&sd, &now_us, 2000);

    uint8_t read_buf[512] = {0};
    sd_spi_begin_read(&sd, 2, read_buf, now_us);

    sd_spi_status_t st = drive_sd_poll_until_done(&sd, &now_us, 3000);
    assert(st == SD_SPI_ERR_CRC);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_ERROR);
    printf("       -> PASS: Bad CRC detected, state transitioned to ERROR\n");
}

static void test_write_success(void) {
    printf("[TEST] 5. Write single block (512B) CMD24 success & busy wait...\n");
    reset_mock_card(MOCK_CARD_SDHC_64GB);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);
    drive_sd_poll_until_done(&sd, &now_us, 2000);

    uint8_t write_buf[512];
    for (int i = 0; i < 512; i++) {
        write_buf[i] = (uint8_t)(0xA5 ^ i);
    }

    sd_spi_status_t st = sd_spi_begin_write(&sd, 5, write_buf, now_us);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_WRITING);

    st = drive_sd_poll_until_done(&sd, &now_us, 3000);
    assert(st == SD_SPI_OK);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_READY);

    /* Verify mock memory for sector 5 was updated */
    for (int i = 0; i < 512; i++) {
        assert(g_mock.memory[5][i] == (uint8_t)(0xA5 ^ i));
    }
    printf("       -> PASS: Write 512 bytes to sector 5 accepted & verified\n");
}

static void test_write_rejected(void) {
    printf("[TEST] 6. Write block reject handling (data response error)...\n");
    reset_mock_card(MOCK_CARD_WRITE_REJECT);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);
    drive_sd_poll_until_done(&sd, &now_us, 2000);

    uint8_t write_buf[512] = {0};
    sd_spi_begin_write(&sd, 1, write_buf, now_us);

    sd_spi_status_t st = drive_sd_poll_until_done(&sd, &now_us, 3000);
    assert(st == SD_SPI_ERR_CRC || st == SD_SPI_ERR_REJECTED);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_ERROR);
    printf("       -> PASS: Write rejection handled, state transitioned to ERROR\n");
}

static void test_timeout_unplugged(void) {
    printf("[TEST] 7. Timeout / card removed handling...\n");
    reset_mock_card(MOCK_CARD_UNRESPONSIVE);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);

    sd_spi_status_t st = drive_sd_poll_until_done(&sd, &now_us, 10000);
    assert(st == SD_SPI_ERR_TIMEOUT);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_ERROR);
    printf("       -> PASS: Timeout handled, fail-closed to ERROR state\n");
}

static void test_out_of_bounds_and_refusal(void) {
    printf("[TEST] 8. Out-of-bounds address & invalid state refusal checks...\n");
    reset_mock_card(MOCK_CARD_SDHC_64GB);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint8_t buf[512];
    uint64_t now_us = 1000;

    /* 1. Try reading before initialization */
    sd_spi_status_t st = sd_spi_begin_read(&sd, 0, buf, now_us);
    assert(st == SD_SPI_ERR_NOT_READY);

    /* 2. Initialize card */
    sd_spi_begin_init(&sd, now_us);
    drive_sd_poll_until_done(&sd, &now_us, 2000);
    assert(sd_spi_get_state(&sd) == SD_SPI_STATE_READY);

    /* 3. Try reading sector beyond capacity */
    st = sd_spi_begin_read(&sd, 200000000ULL, buf, now_us);
    assert(st == SD_SPI_ERR_OUT_OF_BOUNDS);

    st = sd_spi_begin_write(&sd, 200000000ULL, buf, now_us);
    assert(st == SD_SPI_ERR_OUT_OF_BOUNDS);

    /* 4. Try passing NULL buffer */
    st = sd_spi_begin_read(&sd, 0, NULL, now_us);
    assert(st == SD_SPI_ERR_INVALID_ARG);

    /* 5. Start read and attempt concurrent second read */
    st = sd_spi_begin_read(&sd, 0, buf, now_us);
    assert(st == SD_SPI_OK);

    st = sd_spi_begin_read(&sd, 1, buf, now_us);
    assert(st == SD_SPI_ERR_NOT_READY || st == SD_SPI_ERR_BUSY);

    drive_sd_poll_until_done(&sd, &now_us, 3000);

    printf("       -> PASS: All boundary and state refusal checks verified\n");
}

static void test_bounded_callback_execution(void) {
    printf("[TEST] 9. Bounded constant-work callback verification...\n");
    reset_mock_card(MOCK_CARD_SDHC_64GB);

    sd_spi_io_t io = create_mock_io();
    sd_spi_t sd;
    sd_spi_init_ctx(&sd, &io);

    uint64_t now_us = 1000;
    sd_spi_begin_init(&sd, now_us);

    g_mock.max_calls_per_poll = 0;
    drive_sd_poll_until_done(&sd, &now_us, 2000);

    /* Verify that no single call to sd_poll() invoked callbacks more than 5 times */
    assert(g_mock.max_calls_per_poll <= 5);
    printf("       -> PASS: Max IO callbacks per sd_poll() call = %u (strictly bounded O(1))\n",
           g_mock.max_calls_per_poll);
}

static void test_additional_guards(void){
 uint8_t cmd0[]={0x40,0,0,0,0},cmd8[]={0x48,0,0,1,0xaa};
 assert(sd_crc7(cmd0,5)==0x4a&&sd_crc7(cmd8,5)==0x43);
 assert(sd_crc16((const uint8_t*)"123456789",9)==0x31c3);
 sd_spi_t sd;sd_spi_io_t io=create_mock_io();uint64_t now=1000;
 reset_mock_card(MOCK_CARD_CSD_BAD_CRC);sd_spi_init_ctx(&sd,&io);assert(sd_spi_begin_init(&sd,now)==SD_SPI_OK);
 assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_ERR_CRC);assert(!g_mock.cs_asserted);
 reset_mock_card(MOCK_CARD_CSD_MAX);sd_spi_init_ctx(&sd,&io);assert(sd_spi_begin_init(&sd,now)==SD_SPI_OK);
 assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);assert(sd.card_info.capacity_sectors==4294967296ULL);assert(sd.card_info.capacity_bytes==2199023255552ULL);
 io.cs_select=NULL;sd_spi_init_ctx(&sd,&io);assert(sd_spi_begin_init(&sd,now)==SD_SPI_ERR_INVALID_ARG);
 io=create_mock_io();reset_mock_card(MOCK_CARD_SDHC_64GB);sd_spi_init_ctx(&sd,&io);assert(sd_spi_begin_init(&sd,now)==SD_SPI_OK);assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);
 uint8_t data[512];memset(data,0xfe,sizeof data);assert(sd_spi_begin_write(&sd,7,data,now)==SD_SPI_OK);assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);assert(!memcmp(data,g_mock.memory[7],512));
 memset(data,0,sizeof data);assert(sd_spi_begin_read(&sd,7,data,now)==SD_SPI_OK);assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);for(unsigned i=0;i<512;i++)assert(data[i]==0xfe);assert(!g_mock.cs_asserted);
 reset_mock_card(MOCK_CARD_WRITE_DELAY);sd_spi_init_ctx(&sd,&io);assert(sd_spi_begin_init(&sd,now)==SD_SPI_OK);assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);
 assert(sd_spi_begin_write(&sd,3,data,now)==SD_SPI_OK);assert(drive_sd_poll_until_done(&sd,&now,2000)==SD_SPI_OK);assert(!memcmp(data,g_mock.memory[3],512));
 puts("PASS extra guards: delayed write response, independent CRC vectors, CSD CRC rejection, 2TiB counter boundary, missing CS callback, payload starting with token byte, sequential write/read");
}

int main(void) {
    printf("====================================================\n");
    printf(" Running SD SPI State Machine Standalone Unit Tests \n");
    printf("====================================================\n\n");

    test_init_high_capacity_success();
    test_init_sdsc_rejection();
    test_read_success_and_crc();
    test_read_bad_crc();
    test_write_success();
    test_write_rejected();
    test_timeout_unplugged();
    test_out_of_bounds_and_refusal();
    test_bounded_callback_execution();
    test_additional_guards();

    printf("\n====================================================\n");
    printf(" ALL 9 MOCK SD SPI UNIT TESTS PASSED SUCCESSFULLY!  \n");
    printf("====================================================\n");
    return 0;
}
