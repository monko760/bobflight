/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_FAT32_LOG_H
#define BOBFLIGHT_FAT32_LOG_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FATLOG_SECTOR_SIZE 512

/**
 * @brief Asynchronous Block I/O Callbacks Contract.
 * read/write starts a single 512-byte asynchronous transfer.
 * poll returns 0 pending, 1 done, -1 error.
 */
typedef struct fatlog_io {
    void *ctx;
    uint64_t sectors;
    bool (*read)(void *ctx, uint32_t sector, uint8_t *buffer);
    bool (*write)(void *ctx, uint32_t sector, const uint8_t *buffer);
    int (*poll)(void *ctx, uint64_t now);
} fatlog_io_t;

/**
 * @brief Execution phase enumeration.
 */
typedef enum {
    FATLOG_IDLE = 0,
    FATLOG_PREPARING,
    FATLOG_READY,
    FATLOG_WRITING,
    FATLOG_CLOSING,
    FATLOG_DONE,
    FATLOG_ERROR
} fatlog_phase_t;

/**
 * @brief Main FAT32 log writer structure (static storage, no heap).
 */
typedef struct fatlog fatlog_t;

struct fatlog {
    /* Exposed public fields */
    fatlog_phase_t phase;
    char filename[13];
    uint64_t bytes_written;
    const char *error;

    /* I/O Callback interface */
    fatlog_io_t io;

    /* Substate machine */
    uint16_t substate;
    bool io_pending;
    bool dirty_started, verify_due, io_is_write, fsinfo_return_close;
    uint32_t verify_lba;
    uint64_t poll_now, io_started;
    uint8_t verify_buf[512];
    uint32_t io_target_sector;

    /* Bounded sector buffers (no heap, no stack sector arrays) */
    uint8_t sector_buf[FATLOG_SECTOR_SIZE];
    uint8_t write_buf[FATLOG_SECTOR_SIZE];
    uint8_t fat_staging_buf[FATLOG_SECTOR_SIZE];

    /* Geometry & Volume parameters */
    uint32_t partition_lba;
    uint32_t partition_sectors;
    uint32_t total_sectors;
    uint16_t reserved_sectors;
    uint8_t num_fats;
    uint8_t sectors_per_cluster;
    uint32_t fat_size_sectors;
    uint32_t root_cluster;
    uint16_t fsinfo_sector;
    uint16_t backup_boot_sector;
    uint32_t fat1_lba;
    uint32_t fat2_lba;
    uint32_t data_lba;
    uint32_t total_clusters;

    /* FSInfo cached state */
    uint32_t fsinfo_free_count;
    uint32_t fsinfo_next_free;

    /* Root directory scan & target entry placement */
    uint32_t current_dir_cluster;
    uint32_t dir_sector_offset;
    uint32_t target_dir_lba;
    uint16_t target_dir_offset;
    bool target_dir_is_end;
    bool target_slot_found;
    bool need_next_sec_end_marker;
    uint32_t visited_root_clusters[16];
    uint8_t root_cluster_count;

    uint8_t used_name_mask[128]; /* Bitmask tracking used BFLxxxxx numbers 0..1023 */
    uint32_t bfl_number;

    /* File allocation state */
    uint32_t start_cluster;
    uint32_t current_cluster;
    uint32_t cluster_sec_offset;
    uint32_t search_fat_cluster;
    uint32_t search_fat_sector;
    uint32_t fat_scan_start_sector;
    uint32_t fat_scanned_count;

    /* Allocation linking state */
    uint32_t link_new_cluster;
    uint32_t link_prev_cluster;

    /* Data write state */
    uint16_t write_used_bytes;
    bool is_short_final;

    /* Clean / Dirty bit state */
    uint32_t fat_entry1_val;
};

/**
 * @brief Initialize/mount/create unique BFLxxxxx.BBL log file.
 * @param fs Pointer to fatlog context.
 * @param io Pointer to block I/O callbacks struct.
 * @param now Current timestamp.
 * @return true if sequence started successfully, false on invalid args or wrong state.
 */
bool fatlog_start(fatlog_t *fs, const fatlog_io_t *io, uint64_t now);

/**
 * @brief Non-blocking state machine poll.
 * Advances bounded work without blocking loops or heap.
 * @param fs Pointer to fatlog context.
 * @param now Current timestamp.
 * @return Current phase (cast to int).
 */
int fatlog_poll(fatlog_t *fs, uint64_t now);

/**
 * @brief Accept one 512-byte sector to log when READY.
 * Copies sector internally. used must be 1..512.
 * short sector (used < 512) is allowed for final sector only.
 * @param fs Pointer to fatlog context.
 * @param sector Buffer containing 512 bytes data.
 * @param used Number of valid data bytes in sector (1..512).
 * @param now Current timestamp.
 * @return true if accepted, false if not ready, invalid used, or already short final.
 */
bool fatlog_write(fatlog_t *fs, const uint8_t sector[FATLOG_SECTOR_SIZE], uint16_t used, uint64_t now);

/**
 * @brief Finish log file writing, finalize file size, update FSInfo, and clean volume status bit.
 * @param fs Pointer to fatlog context.
 * @param now Current timestamp.
 * @return true if close sequence started, false if not ready or busy.
 */
bool fatlog_close(fatlog_t *fs, uint64_t now);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FAT32_LOG_H */
