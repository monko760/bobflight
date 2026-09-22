/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * @file sd_spi.h
 * @brief Non-blocking SD Card SPI Mode State Machine
 *
 * Designed for embedded systems (e.g. Kakute F745 flight recorder / .bbl logging).
 * Supports SDHC/SDXC cards in SPI mode with non-blocking, bounded IO.
 */

#ifndef SD_SPI_H
#define SD_SPI_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SD_SPI_BLOCK_SIZE 512

/**
 * @brief Return codes for SD SPI operations.
 */
typedef enum {
    SD_SPI_OK = 0,
    SD_SPI_ERR_BUSY,          /**< Operation in progress / busy */
    SD_SPI_ERR_NOT_READY,      /**< Card not initialized or in error state */
    SD_SPI_ERR_OUT_OF_BOUNDS, /**< Sector address exceeds capacity */
    SD_SPI_ERR_INVALID_ARG,   /**< Null buffer or invalid parameters */
    SD_SPI_ERR_TIMEOUT,       /**< Operation timed out */
    SD_SPI_ERR_CRC,           /**< Data block CRC16 mismatch */
    SD_SPI_ERR_REJECTED,      /**< Write data rejected by card */
    SD_SPI_ERR_HARDWARE,      /**< IO callback reported hardware failure */
    SD_SPI_ERR_UNSUPPORTED    /**< Card type not supported (e.g. non-SDHC card) */
} sd_spi_status_t;

/**
 * @brief Main state machine states.
 */
typedef enum {
    SD_SPI_STATE_UNINITIALIZED = 0,
    SD_SPI_STATE_INITIALIZING,
    SD_SPI_STATE_READY,
    SD_SPI_STATE_READING,
    SD_SPI_STATE_WRITING,
    SD_SPI_STATE_ERROR
} sd_spi_state_t;

/**
 * @brief SPI clock speed configuration modes.
 */
typedef enum {
    SD_SPI_SPEED_SLOW = 0, /**< Initialization speed <= 400 kHz */
    SD_SPI_SPEED_FAST      /**< Normal transfer speed <= 25 MHz */
} sd_spi_speed_t;

/**
 * @brief Status returned by non-blocking single-byte exchange poll callback.
 */
typedef enum {
    SD_SPI_IO_PENDING = 0, /**< Byte exchange is still in progress */
    SD_SPI_IO_DONE,        /**< Byte exchange complete; rx_byte holds received byte */
    SD_SPI_IO_ERROR        /**< Bus/hardware error during exchange */
} sd_spi_io_status_t;

/**
 * @brief Hardware IO Callbacks supplied by caller / HAL.
 */
typedef struct {
    /** Assert (true = low) or deassert (false = high) Chip Select line */
    void (*cs_select)(bool assert_cs, void *user_ctx);

    /** Configure SPI clock frequency mode */
    void (*set_speed)(sd_spi_speed_t speed, void *user_ctx);

    /** Start non-blocking exchange of ONE byte on SPI bus */
    void (*spi_start_exchange)(uint8_t tx_byte, void *user_ctx);

    /** Poll current single-byte exchange status. Stores received byte in *rx_byte when DONE. */
    sd_spi_io_status_t (*spi_poll_exchange)(uint8_t *rx_byte, void *user_ctx);

    /** User context pointer passed to callbacks */
    void *user_ctx;
} sd_spi_io_t;

/**
 * @brief Parsed SDHC/SDXC card information.
 */
typedef struct {
    uint64_t capacity_sectors; /**< Capacity in 512-byte blocks */
    uint64_t capacity_bytes;   /**< Capacity in total bytes */
    uint32_t c_size;           /**< Parsed C_SIZE value from CSDv2 */
    uint8_t  csd[16];          /**< Raw CSD register (16 bytes) */
    uint8_t  ocr[4];           /**< Raw OCR response bytes (4 bytes) */
} sd_spi_card_info_t;

/**
 * @brief Internal sub-states for non-blocking state machine.
 */
typedef enum {
    SUB_IDLE = 0,

    /* Init sequence substates */
    SUB_INIT_POWER_CLOCKS,
    SUB_INIT_CMD0_SEND,
    SUB_INIT_CMD0_RESP,
    SUB_INIT_CMD8_SEND,
    SUB_INIT_CMD8_RESP,
    SUB_INIT_CMD8_DATA,
    SUB_INIT_ACMD41_LOOP,
    SUB_INIT_CMD55_SEND,
    SUB_INIT_CMD55_RESP,
    SUB_INIT_ACMD41_SEND,
    SUB_INIT_ACMD41_RESP,
    SUB_INIT_CMD58_SEND,
    SUB_INIT_CMD58_RESP,
    SUB_INIT_CMD58_DATA,
    SUB_INIT_SWITCH_SPEED,
    SUB_INIT_CMD9_SEND,
    SUB_INIT_CMD9_RESP,
    SUB_INIT_CSD_WAIT_TOKEN,
    SUB_INIT_CSD_READ_DATA,
    SUB_INIT_CSD_READ_CRC,
    SUB_INIT_FINISH,

    /* Read sequence substates */
    SUB_READ_CMD17_SEND,
    SUB_READ_CMD17_RESP,
    SUB_READ_WAIT_TOKEN,
    SUB_READ_DATA_BYTES,
    SUB_READ_CRC16,
    SUB_READ_FINISH,

    /* Write sequence substates */
    SUB_WRITE_CMD24_SEND,
    SUB_WRITE_CMD24_RESP,
    SUB_WRITE_GAP_BYTE,
    SUB_WRITE_TOKEN,
    SUB_WRITE_DATA_BYTES,
    SUB_WRITE_CRC16_SEND,
    SUB_WRITE_RESP,
    SUB_WRITE_BUSY_WAIT,
    SUB_WRITE_FINISH
} sd_spi_substate_t;

/**
 * @brief Main SD SPI state machine structure.
 */
typedef struct {
    sd_spi_io_t io;
    sd_spi_state_t state;
    sd_spi_substate_t substate;
    sd_spi_status_t last_error;

    sd_spi_card_info_t card_info;

    /* Transfer state */
    bool io_active;               /**< True if a single byte exchange was started */
    uint8_t cmd_buf[7];           /**< Outgoing 6-byte command packet */
    uint8_t cmd_idx;              /**< Command transmission index */
    uint8_t resp_buf[16];         /**< Received command response / register bytes */
    uint8_t resp_idx;             /**< Response byte index */
    uint8_t resp_expected;        /**< Expected response length */
    uint16_t data_idx;            /**< Data transfer index (0 to 512) */
    uint8_t *data_buf;            /**< Caller-owned 512B buffer pointer */
    uint32_t target_sector;       /**< Sector index requested */

    uint16_t expected_crc16;      /**< Computed or received CRC16 */
    uint16_t rx_crc16;            /**< Received CRC16 from card */

    /* Timing and retries */
    uint64_t op_start_us;         /**< Microsecond timestamp when operation started */
    uint64_t step_start_us;       /**< Timestamp when current step started */
    uint32_t ncr_attempts;        /**< Dummy byte read count waiting for response */

    /* Cleanup flag */
    bool cs_asserted;             /**< Current CS line state */
} sd_spi_t;

/* --- Utility / Helper functions --- */

/**
 * @brief Compute SD command CRC7 (polynomial x^7 + x^3 + 1).
 * @param data Pointer to 5 command bytes.
 * @param len Byte length (typically 5).
 * @return 7-bit CRC value.
 */
uint8_t sd_crc7(const uint8_t *data, size_t len);

/**
 * @brief Compute SD data block CRC16 CCITT (polynomial x^16 + x^12 + x^5 + 1).
 * @param data Pointer to data block.
 * @param len Byte length (typically 512).
 * @return 16-bit CRC value.
 */
uint16_t sd_crc16(const uint8_t *data, size_t len);

/* --- API Functions --- */

/**
 * @brief Initialize SD SPI state machine context.
 * @param sd Pointer to state machine context struct.
 * @param io Pointer to IO callbacks struct.
 */
void sd_spi_init_ctx(sd_spi_t *sd, const sd_spi_io_t *io);

/**
 * @brief Begin card initialization sequence.
 * @param sd Pointer to state machine context.
 * @param now_us Current microsecond timestamp.
 * @return SD_SPI_OK if sequence started, or error code.
 */
sd_spi_status_t sd_spi_begin_init(sd_spi_t *sd, uint64_t now_us);

/**
 * @brief Begin single block (512-byte) read operation.
 * Refused if not ready, busy, or sector address out of range.
 * @param sd Pointer to state machine context.
 * @param sector Sector index (512-byte block address).
 * @param buffer Pointer to caller-owned stable 512B buffer.
 * @param now_us Current microsecond timestamp.
 * @return SD_SPI_OK if operation queued, or error code.
 */
sd_spi_status_t sd_spi_begin_read(sd_spi_t *sd, uint32_t sector, uint8_t *buffer, uint64_t now_us);

/**
 * @brief Begin single block (512-byte) write operation.
 * Refused if not ready, busy, or sector address out of range.
 * Pure transport write: only occurs upon explicit caller invoke.
 * @param sd Pointer to state machine context.
 * @param sector Sector index (512-byte block address).
 * @param buffer Pointer to caller-owned stable 512B buffer containing payload.
 * @param now_us Current microsecond timestamp.
 * @return SD_SPI_OK if operation queued, or error code.
 */
sd_spi_status_t sd_spi_begin_write(sd_spi_t *sd, uint32_t sector, const uint8_t *buffer, uint64_t now_us);

/**
 * @brief Non-blocking state machine poll.
 * Must be called periodically. Does a bounded constant amount of work per call.
 * No wait loops, delays, or blocking operations.
 * @param sd Pointer to state machine context.
 * @param now_us Current microsecond timestamp.
 * @return SD_SPI_OK when idle or step completes, SD_SPI_ERR_BUSY when work ongoing, or error status.
 */
sd_spi_status_t sd_poll(sd_spi_t *sd, uint64_t now_us);

/**
 * @brief Get current state machine state.
 */
sd_spi_state_t sd_spi_get_state(const sd_spi_t *sd);

/**
 * @brief Get parsed card info (valid when state is SD_SPI_STATE_READY).
 */
const sd_spi_card_info_t *sd_spi_get_card_info(const sd_spi_t *sd);

/**
 * @brief Get last recorded error status.
 */
sd_spi_status_t sd_spi_get_last_error(const sd_spi_t *sd);

#ifdef __cplusplus
}
#endif

#endif /* SD_SPI_H */
