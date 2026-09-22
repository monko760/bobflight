/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * @file fat32_log.c
 * @brief Hardened Asynchronous FAT32 log-file writer implementation.
 *
 * Designed for embedded systems with non-blocking, bounded block I/O.
 * Creates a unique root 8.3 BFLxxxxx.BBL file on an existing healthy FAT32 volume,
 * preserving all pre-existing files and directory structure.
 */

#include "drivers/fat32_log.h"
#include <string.h>
#include <stdio.h>

/* --- Substates for State Machine --- */

typedef enum {
    SUB_IDLE = 0,

    /* PREPARING Substates */
    SUB_PREP_READ_MBR,
    SUB_PREP_PARSE_MBR,
    SUB_PREP_READ_VBR,
    SUB_PREP_PARSE_VBR,
    SUB_PREP_READ_BACKUP_BOOT,
    SUB_PREP_CHECK_BACKUP_BOOT,
    SUB_PREP_READ_FAT1_SEC0,
    SUB_PREP_CHECK_FAT1_SEC0,
    SUB_PREP_READ_FAT2_SEC0,
    SUB_PREP_CHECK_FAT2_SEC0,
    SUB_PREP_WRITE_DIRTY_FAT1,
    SUB_PREP_READ_VERIFY_DIRTY_FAT1,
    SUB_PREP_CHECK_VERIFY_DIRTY_FAT1,
    SUB_PREP_WRITE_DIRTY_FAT2,
    SUB_PREP_READ_VERIFY_DIRTY_FAT2,
    SUB_PREP_CHECK_VERIFY_DIRTY_FAT2,
    SUB_PREP_READ_FSINFO,
    SUB_PREP_PARSE_FSINFO,
    SUB_PREP_READ_ROOT_SEC,
    SUB_PREP_SCAN_ROOT_SEC,
    SUB_PREP_READ_ROOT_FAT_NEXT,
    SUB_PREP_PARSE_ROOT_FAT_NEXT,
    SUB_PREP_READ_ROOT_FAT2_NEXT,
    SUB_PREP_CHECK_ROOT_FAT2_NEXT,
    SUB_PREP_CHOOSE_FILENAME,
    SUB_PREP_READ_FAT_SEC,
    SUB_PREP_SCAN_FAT_SEC,
    SUB_PREP_READ_FAT2_SEC,
    SUB_PREP_CHECK_FAT2_SEC,
    SUB_PREP_WRITE_FIRST_CLUSTER_FAT1,
    SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT1,
    SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT1,
    SUB_PREP_WRITE_FIRST_CLUSTER_FAT2,
    SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT2,
    SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT2,
    SUB_PREP_READ_TARGET_DIR_SEC,
    SUB_PREP_WRITE_TARGET_DIR_SEC,
    SUB_PREP_READ_VERIFY_DIR_SEC,
    SUB_PREP_CHECK_VERIFY_DIR_SEC,
    SUB_PREP_READ_NEXT_DIR_SEC,
    SUB_PREP_WRITE_NEXT_DIR_SEC,
    SUB_PREP_READ_VERIFY_NEXT_DIR_SEC,
    SUB_PREP_CHECK_VERIFY_NEXT_DIR_SEC,
    SUB_PREP_READ_FSINFO_FOR_UPDATE,
    SUB_PREP_WRITE_FSINFO,
    SUB_PREP_READ_VERIFY_FSINFO,
    SUB_PREP_CHECK_VERIFY_FSINFO,
    SUB_PREP_FINISH,

    /* WRITING Substates */
    SUB_WRITE_CHECK_CLUSTER,
    SUB_WRITE_SEARCH_NEXT_CLUSTER,
    SUB_WRITE_READ_FAT_SEC,
    SUB_WRITE_SCAN_FAT_SEC,
    SUB_WRITE_READ_FAT2_SEC,
    SUB_WRITE_CHECK_FAT2_SEC,

    /* Safe Cluster Linking Substates */
    /* Step 1: Write EOC to new cluster in FAT1 & FAT2 */
    SUB_WRITE_READ_NEW_FAT1,
    SUB_WRITE_SET_NEW_FAT1,
    SUB_WRITE_READ_VERIFY_NEW_FAT1,
    SUB_WRITE_CHECK_VERIFY_NEW_FAT1,
    SUB_WRITE_READ_NEW_FAT2,
    SUB_WRITE_SET_NEW_FAT2,
    SUB_WRITE_READ_VERIFY_NEW_FAT2,
    SUB_WRITE_CHECK_VERIFY_NEW_FAT2,

    /* Step 2: Link old cluster to new cluster in FAT1 & FAT2 */
    SUB_WRITE_READ_PREV_FAT1,
    SUB_WRITE_LINK_PREV_FAT1,
    SUB_WRITE_READ_VERIFY_PREV_FAT1,
    SUB_WRITE_CHECK_VERIFY_PREV_FAT1,
    SUB_WRITE_READ_PREV_FAT2,
    SUB_WRITE_LINK_PREV_FAT2,
    SUB_WRITE_READ_VERIFY_PREV_FAT2,
    SUB_WRITE_CHECK_VERIFY_PREV_FAT2,

    SUB_WRITE_DO_DATA_WRITE,
    SUB_WRITE_READ_VERIFY_DATA,
    SUB_WRITE_CHECK_VERIFY_DATA,

    /* CLOSING Substates */
    SUB_CLOSE_READ_DIR_SEC,
    SUB_CLOSE_WRITE_DIR_SEC,
    SUB_CLOSE_READ_VERIFY_DIR,
    SUB_CLOSE_CHECK_VERIFY_DIR,
    SUB_CLOSE_READ_FSINFO,
    SUB_CLOSE_WRITE_FSINFO,
    SUB_CLOSE_READ_VERIFY_FSINFO,
    SUB_CLOSE_CHECK_VERIFY_FSINFO,
    SUB_CLOSE_READ_FAT1_SEC0,
    SUB_CLOSE_WRITE_CLEAN_FAT1,
    SUB_CLOSE_READ_VERIFY_CLEAN_FAT1,
    SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT1,
    SUB_CLOSE_WRITE_CLEAN_FAT2,
    SUB_CLOSE_READ_VERIFY_CLEAN_FAT2,
    SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT2,
    SUB_CLOSE_FINISH,
    SUB_PREP_ROOT_ALLOC1, SUB_PREP_ROOT_ALLOC2,
    SUB_PREP_BACKUP_FSI_CHECK, SUB_PREP_LOAD_DIRTY,
    SUB_WRITE_CHECK_PREV_FAT2, SUB_WRITE_COMMIT_PREV, SUB_CLOSE_CHECK_FAT2, SUB_CLOSE_COMMIT_CLEAN,
    SUB_BACKUP_FSI_WRITE, SUB_BACKUP_FSI_VERIFY, SUB_BACKUP_FSI_DONE
} fatlog_substate_t;

/* --- Internal Helper Functions --- */

static inline uint16_t get16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static inline uint32_t get32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline void put16(uint8_t *p, uint16_t val) {
    p[0] = (uint8_t)val;
    p[1] = (uint8_t)(val >> 8);
}

static inline void put32(uint8_t *p, uint32_t val) {
    put16(p, (uint16_t)val);
    put16(p + 2, (uint16_t)(val >> 16));
}

static inline bool is_power_of_two(uint32_t x) {
    return (x != 0) && ((x & (x - 1)) == 0);
}

static void set_error(fatlog_t *fs, const char *msg) {
    fs->phase = FATLOG_ERROR;
    fs->error = msg;
    fs->substate = SUB_IDLE;
    fs->io_pending = false;
}

static uint64_t cluster_to_lba(const fatlog_t *fs, uint32_t cluster, uint32_t sec_offset) {
    return (uint64_t)fs->data_lba + (uint64_t)(cluster - 2) * fs->sectors_per_cluster + sec_offset;
}

static uint64_t fat_cluster_to_lba(const fatlog_t *fs, uint8_t fat_idx, uint32_t cluster) {
    uint32_t base_lba = (fat_idx == 1) ? fs->fat1_lba : fs->fat2_lba;
    return (uint64_t)base_lba + ((uint64_t)cluster * 4) / FATLOG_SECTOR_SIZE;
}

static uint16_t fat_cluster_to_offset(uint32_t cluster) {
    return (uint16_t)(((uint64_t)cluster * 4) % FATLOG_SECTOR_SIZE);
}

static bool start_async_read(fatlog_t *fs, uint64_t sector_lba) {
    if (sector_lba >= fs->io.sectors || sector_lba > UINT32_MAX || (fs->total_sectors && sector_lba >= (uint64_t)fs->partition_lba + fs->total_sectors)) {
        set_error(fs, "sector-address-out-of-bounds");
        return false;
    }
    if (sector_lba < fs->partition_lba && fs->substate != SUB_PREP_READ_MBR && fs->substate != SUB_PREP_PARSE_MBR) {
        /* Unless reading MBR, all operations must stay within partition */
        set_error(fs, "sector-address-outside-partition");
        return false;
    }
    fs->io_target_sector = (uint32_t)sector_lba;
    if (!fs->io.read(fs->io.ctx, (uint32_t)sector_lba, fs->sector_buf)) {
        set_error(fs, "read-io-start-failed");
        return false;
    }
    fs->io_pending = true;
    fs->io_started=fs->poll_now;
    fs->io_is_write=false;
    return true;
}

static bool start_async_write(fatlog_t *fs, uint64_t sector_lba, const uint8_t *buf) {
    if (sector_lba >= fs->io.sectors || sector_lba > UINT32_MAX || (fs->total_sectors && sector_lba >= (uint64_t)fs->partition_lba + fs->total_sectors)) {
        set_error(fs, "sector-address-out-of-bounds");
        return false;
    }
    if (sector_lba < fs->partition_lba || sector_lba >= (uint64_t)fs->partition_lba + fs->partition_sectors) {
        set_error(fs, "sector-address-outside-partition");
        return false;
    }
    fs->io_target_sector = (uint32_t)sector_lba;
    if(fs->verify_due){set_error(fs,"unverified-previous-write");return false;}
    memcpy(fs->verify_buf,buf,512);fs->verify_lba=(uint32_t)sector_lba;fs->verify_due=true;
    if (!fs->io.write(fs->io.ctx, (uint32_t)sector_lba, fs->verify_buf)) {
        set_error(fs, "write-io-start-failed");
        return false;
    }
    fs->io_pending = true;fs->io_started=fs->poll_now;fs->io_is_write=true;
    return true;
}

/* --- Public API Implementation --- */

bool fatlog_start(fatlog_t *fs, const fatlog_io_t *io, uint64_t now) {
    (void)now;
    if (!fs || !io || !io->read || !io->write || !io->poll || io->sectors == 0 || io->sectors > UINT32_MAX) {
        return false;
    }

    memset(fs, 0, sizeof(*fs));
    fs->io = *io;fs->poll_now=now;
    fs->phase = FATLOG_PREPARING;
    fs->substate = SUB_PREP_READ_MBR;
    fs->error = NULL;
    fs->bytes_written = 0;

    /* Issue initial read of Sector 0 */
    return start_async_read(fs, 0);
}

bool fatlog_write(fatlog_t *fs, const uint8_t sector[FATLOG_SECTOR_SIZE], uint16_t used, uint64_t now) {
    (void)now;
    if (!fs || !sector || fs->phase != FATLOG_READY) {
        return false;
    }
    fs->poll_now=now;
    if (used < 1 || used > FATLOG_SECTOR_SIZE || fs->bytes_written > UINT32_MAX-used) {
        return false;
    }
    if (fs->is_short_final) {
        /* Already accepted a short final sector; no further writes permitted */
        return false;
    }

    memcpy(fs->write_buf, sector, FATLOG_SECTOR_SIZE);
    fs->write_used_bytes = used;
    if (used < FATLOG_SECTOR_SIZE) {
        fs->is_short_final = true;
    }

    fs->phase = FATLOG_WRITING;
    fs->substate = SUB_WRITE_CHECK_CLUSTER;
    fs->io_pending = false;

    return true;
}

bool fatlog_close(fatlog_t *fs, uint64_t now) {
    (void)now;
    if (!fs || fs->phase != FATLOG_READY) {
        return false;
    }

    if(!fs->bytes_written)return false; /* Empty files are not committed by this API. */
    fs->poll_now=now;
    fs->phase = FATLOG_CLOSING;
    fs->substate = SUB_CLOSE_READ_DIR_SEC;
    fs->io_pending = false;

    return start_async_read(fs, fs->target_dir_lba);
}

int fatlog_poll(fatlog_t *fs, uint64_t now) {
    if (!fs) {
        return (int)FATLOG_ERROR;
    }

    if (fs->phase == FATLOG_IDLE || fs->phase == FATLOG_READY ||
        fs->phase == FATLOG_DONE || fs->phase == FATLOG_ERROR) {
        return (int)fs->phase;
    }

    fs->poll_now=now;
    if (fs->io_pending) {
        if(now<fs->io_started||now-fs->io_started>3000000u){set_error(fs,"io-timeout");return fs->phase;}
        int res = fs->io.poll(fs->io.ctx, now);
        if (res == 0) {
            /* Transfer still pending */
            return (int)fs->phase;
        }
        if (res < 0) {
            set_error(fs, "io-callback-error");
            return (int)fs->phase;
        }
        fs->io_pending = false;
        if(!fs->io_is_write && fs->verify_due){
            if(fs->io_target_sector!=fs->verify_lba||memcmp(fs->sector_buf,fs->verify_buf,512)){
                set_error(fs,"full-sector-readback-mismatch");return fs->phase;
            }
            fs->verify_due=false;
        }
    }

    /* Advance state machine work */
    switch (fs->substate) {

    /* --- PREPARING Phase --- */

    case SUB_PREP_READ_MBR:
        fs->substate = SUB_PREP_PARSE_MBR;
        /* fallthrough */

    case SUB_PREP_PARSE_MBR: {
        if (get16(fs->sector_buf + 510) != 0xAA55) {
            set_error(fs, "invalid-boot-signature");
            break;
        }

        if (memcmp(fs->sector_buf + 3, "EXFAT   ", 8) == 0) {
            set_error(fs, "exFAT-not-supported");
            break;
        }

        const uint8_t *part_table = fs->sector_buf + 0x01BE;
        if (part_table[4] == 0xEE) {
            set_error(fs, "GPT-not-supported");
            break;
        }

        uint16_t bps = get16(fs->sector_buf + 11);
        if (bps == FATLOG_SECTOR_SIZE && memcmp(fs->sector_buf + 82, "FAT32   ", 8) == 0) {
            fs->partition_lba = 0;
            fs->partition_sectors = (uint32_t)fs->io.sectors;
            fs->substate = SUB_PREP_PARSE_VBR;
            break;
        }

        uint32_t found_lba = 0;
        uint32_t found_sec = 0;
        for (int i = 0; i < 4; i++) {
            const uint8_t *entry = part_table + i * 16;
            uint8_t ptype = entry[4];
            uint32_t rel_sec = get32(entry + 8);
            uint32_t num_sec = get32(entry + 12);

            if (ptype == 0xEE) {
                set_error(fs, "GPT-not-supported");
                break;
            }

            if (ptype == 0x0B || ptype == 0x0C || ptype == 0x06 || ptype == 0x0E || ptype == 0x07) {
                found_lba = rel_sec;
                found_sec = num_sec;
                break;
            }
            if (found_lba == 0 && rel_sec > 0 && num_sec > 0) {
                found_lba = rel_sec;
                found_sec = num_sec;
            }
        }

        if (fs->phase == FATLOG_ERROR) break;

        if (found_lba == 0 || found_sec == 0) {
            set_error(fs, "no-valid-fat32-partition");
            break;
        }

        if ((uint64_t)found_lba + found_sec > fs->io.sectors) {
            set_error(fs, "partition-exceeds-device-capacity");
            break;
        }

        fs->partition_lba = found_lba;
        fs->partition_sectors = found_sec;
        fs->substate = SUB_PREP_READ_VBR;
        start_async_read(fs, fs->partition_lba);
        break;
    }

    case SUB_PREP_READ_VBR:
        fs->substate = SUB_PREP_PARSE_VBR;
        /* fallthrough */

    case SUB_PREP_PARSE_VBR: {
        if (get16(fs->sector_buf + 510) != 0xAA55) {
            set_error(fs, "invalid-boot-signature");
            break;
        }

        uint16_t bps = get16(fs->sector_buf + 11);
        if (bps != FATLOG_SECTOR_SIZE) {
            set_error(fs, "unsupported-sector-size");
            break;
        }

        uint8_t spc = fs->sector_buf[13];
        if (spc == 0 || !is_power_of_two(spc) || (uint32_t)spc * 512 > 65536) {
            set_error(fs, "invalid-sectors-per-cluster");
            break;
        }
        fs->sectors_per_cluster = spc;

        uint16_t rsvd = get16(fs->sector_buf + 14);
        if (rsvd < 1) {
            set_error(fs, "invalid-reserved-sectors");
            break;
        }
        fs->reserved_sectors = rsvd;

        uint8_t nfats = fs->sector_buf[16];
        if (nfats != 1 && nfats != 2) {
            set_error(fs, "unsupported-num-fats");
            break;
        }
        fs->num_fats = nfats;

        if (get16(fs->sector_buf + 17) != 0) { /* BPB_RootEntCnt */
            set_error(fs, "not-fat32-volume");
            break;
        }
        if (get16(fs->sector_buf + 19) != 0) { /* BPB_TotSec16 */
            set_error(fs, "not-fat32-volume");
            break;
        }
        if (get16(fs->sector_buf + 22) != 0) { /* BPB_FATSz16 */
            set_error(fs, "not-fat32-volume");
            break;
        }

        uint32_t tot_sec = get32(fs->sector_buf + 32);
        if (tot_sec == 0) {
            set_error(fs, "not-fat32-volume");
            break;
        }

        if (tot_sec > fs->partition_sectors) {
            set_error(fs, "partition-smaller-than-volume");
            break;
        }

        if ((uint64_t)fs->partition_lba + tot_sec > fs->io.sectors) {
            set_error(fs, "volume-exceeds-device-capacity");
            break;
        }
        fs->total_sectors = tot_sec;

        uint32_t fat_sz = get32(fs->sector_buf + 36);
        if (fat_sz == 0) {
            set_error(fs, "not-fat32-volume");
            break;
        }
        fs->fat_size_sectors = fat_sz;

        uint16_t ext_flags = get16(fs->sector_buf + 40);
        if ((ext_flags & 0x0080) != 0 || (ext_flags & 0x000F) != 0) {
            set_error(fs, "unsupported-fat-flags");
            break;
        }

        uint16_t fs_ver = get16(fs->sector_buf + 42);
        if (fs_ver != 0) {
            set_error(fs, "unsupported-fat-version");
            break;
        }

        uint32_t root_clus = get32(fs->sector_buf + 44);
        fs->root_cluster = root_clus;

        uint16_t fsi_sec = get16(fs->sector_buf + 48);
        if (fsi_sec == 0 || fsi_sec >= fs->reserved_sectors) {
            set_error(fs, "invalid-fsinfo-location");
            break;
        }
        fs->fsinfo_sector = fsi_sec;

        uint16_t bk_boot = get16(fs->sector_buf + 50);
        if (bk_boot != 0) {
            if (bk_boot >= fs->reserved_sectors || bk_boot == fsi_sec || (uint32_t)bk_boot+fsi_sec>=fs->reserved_sectors) {
                set_error(fs, "invalid-backup-boot-location");
                break;
            }
        }
        fs->backup_boot_sector = bk_boot;

        /* Derived Layout Addresses */
        fs->fat1_lba = fs->partition_lba + fs->reserved_sectors;
        fs->fat2_lba = (fs->num_fats == 2) ? (fs->fat1_lba + fs->fat_size_sectors) : fs->fat1_lba;
        fs->data_lba = fs->fat1_lba + (uint32_t)fs->num_fats * fs->fat_size_sectors;

        uint64_t meta_sec = (uint64_t)fs->reserved_sectors + (uint64_t)fs->num_fats * fs->fat_size_sectors;
        if (meta_sec >= fs->total_sectors) {
            set_error(fs, "invalid-volume-layout");
            break;
        }

        uint32_t data_sec = fs->total_sectors - (uint32_t)meta_sec;
        fs->total_clusters = data_sec / fs->sectors_per_cluster;

        if (fs->total_clusters < 65525 || fs->total_clusters > 0x0fffffedu) {
            set_error(fs, "cluster-count-not-fat32");
            break;
        }

        if (fs->root_cluster < 2 || fs->root_cluster >= fs->total_clusters + 2) {
            set_error(fs, "invalid-root-cluster");
            break;
        }

        uint64_t fat_cap = (uint64_t)fs->fat_size_sectors * (FATLOG_SECTOR_SIZE / 4);
        if (fat_cap < (uint64_t)fs->total_clusters + 2) {
            set_error(fs, "fat-size-too-small");
            break;
        }

        uint64_t data_end = (uint64_t)fs->data_lba + (uint64_t)fs->total_clusters * fs->sectors_per_cluster;
        if (data_end > (uint64_t)fs->partition_lba + fs->total_sectors) {
            set_error(fs, "volume-layout-out-of-bounds");
            break;
        }

        if (fs->backup_boot_sector != 0) {
            fs->substate = SUB_PREP_READ_BACKUP_BOOT;
            start_async_read(fs, fs->partition_lba + fs->backup_boot_sector);
        } else {
            fs->substate = SUB_PREP_READ_FAT1_SEC0;
            start_async_read(fs, fs->fat1_lba);
        }
        break;
    }

    case SUB_PREP_READ_BACKUP_BOOT:
        fs->substate = SUB_PREP_CHECK_BACKUP_BOOT;
        /* fallthrough */

    case SUB_PREP_CHECK_BACKUP_BOOT: {
        if (get16(fs->sector_buf + 510) != 0xAA55) {
            set_error(fs, "invalid-backup-boot-signature");
            break;
        }

        /* Check key parameters match primary VBR */
        if (get16(fs->sector_buf + 11) != FATLOG_SECTOR_SIZE ||
            fs->sector_buf[13] != fs->sectors_per_cluster ||
            get16(fs->sector_buf + 14) != fs->reserved_sectors ||
            fs->sector_buf[16] != fs->num_fats ||
            get32(fs->sector_buf + 32) != fs->total_sectors ||
            get32(fs->sector_buf + 36) != fs->fat_size_sectors ||
            get32(fs->sector_buf + 44) != fs->root_cluster) {
            set_error(fs, "backup-boot-mismatch");
            break;
        }

        fs->substate = SUB_PREP_READ_FAT1_SEC0;
        start_async_read(fs, fs->fat1_lba);
        break;
    }

    case SUB_PREP_READ_FAT1_SEC0:
        fs->substate = SUB_PREP_CHECK_FAT1_SEC0;
        /* fallthrough */

    case SUB_PREP_CHECK_FAT1_SEC0: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);
        uint32_t entry1 = get32(fs->sector_buf + 4);
        fs->fat_entry1_val = entry1;

        if ((entry1 & 0x08000000) == 0) {
            set_error(fs, "volume-dirty");
            break;
        }
        if ((entry1 & 0x04000000) == 0) {
            set_error(fs, "volume-hard-error");
            break;
        }

        if((get32(fs->sector_buf)&0x0fffff00u)!=0x0fffff00u){set_error(fs,"invalid-fat-reserved-entry");break;}
        if (fs->num_fats == 2) {
            fs->substate = SUB_PREP_READ_FAT2_SEC0;
            start_async_read(fs, fs->fat2_lba);
        } else {
            fs->substate=SUB_PREP_ROOT_ALLOC1;start_async_read(fs,fat_cluster_to_lba(fs,1,fs->root_cluster));
        }
        break;
    }

    case SUB_PREP_READ_FAT2_SEC0:
        fs->substate = SUB_PREP_CHECK_FAT2_SEC0;
        /* fallthrough */

    case SUB_PREP_CHECK_FAT2_SEC0: {
        if (memcmp(fs->sector_buf, fs->fat_staging_buf, FATLOG_SECTOR_SIZE) != 0) {
            set_error(fs, "FAT-mirror-mismatch");
            break;
        }

        fs->substate=SUB_PREP_ROOT_ALLOC1;start_async_read(fs,fat_cluster_to_lba(fs,1,fs->root_cluster));break;
    }
    case SUB_PREP_ROOT_ALLOC1:
        memcpy(fs->fat_staging_buf,fs->sector_buf,512);
        fs->substate=SUB_PREP_ROOT_ALLOC2;
        if(fs->num_fats==2)start_async_read(fs,fat_cluster_to_lba(fs,2,fs->root_cluster));
        break;
    case SUB_PREP_ROOT_ALLOC2:
        if(fs->num_fats==2&&memcmp(fs->sector_buf,fs->fat_staging_buf,512)){set_error(fs,"FAT-mirror-mismatch");break;}
        if((get32(fs->fat_staging_buf+fat_cluster_to_offset(fs->root_cluster))&0x0fffffffu)<0x0ffffff8u){set_error(fs,"root-must-be-one-allocated-cluster");break;}
        fs->substate=SUB_PREP_READ_FSINFO;start_async_read(fs,fs->partition_lba+fs->fsinfo_sector);break;
    case SUB_PREP_LOAD_DIRTY:
        memcpy(fs->fat_staging_buf,fs->sector_buf,512);fs->dirty_started=true;
        fs->substate=SUB_PREP_WRITE_DIRTY_FAT1;break;

    case SUB_PREP_WRITE_DIRTY_FAT1: {
        uint32_t val = get32(fs->fat_staging_buf + 4);
        uint32_t new_val = (val & 0xF0000000) | ((val & 0x0FFFFFFF) & ~0x08000000);
        put32(fs->fat_staging_buf + 4, new_val);

        fs->substate = SUB_PREP_READ_VERIFY_DIRTY_FAT1;
        start_async_write(fs, fs->fat1_lba, fs->fat_staging_buf);
        break;
    }

    case SUB_PREP_READ_VERIFY_DIRTY_FAT1:
        fs->substate = SUB_PREP_CHECK_VERIFY_DIRTY_FAT1;
        start_async_read(fs, fs->fat1_lba);
        break;

    case SUB_PREP_CHECK_VERIFY_DIRTY_FAT1: {
        uint32_t entry1 = get32(fs->sector_buf + 4);
        if ((entry1 & 0x08000000) != 0) {
            set_error(fs, "write-dirty-failed");
            break;
        }

        if (fs->num_fats == 2) {
            fs->substate = SUB_PREP_READ_VERIFY_DIRTY_FAT2;
            start_async_write(fs, fs->fat2_lba, fs->fat_staging_buf);
        } else {
            fs->substate = SUB_PREP_READ_FAT_SEC;
            start_async_read(fs, fs->search_fat_sector);
        }
        break;
    }

    case SUB_PREP_READ_VERIFY_DIRTY_FAT2:
        fs->substate = SUB_PREP_CHECK_VERIFY_DIRTY_FAT2;
        start_async_read(fs, fs->fat2_lba);
        break;

    case SUB_PREP_CHECK_VERIFY_DIRTY_FAT2: {
        uint32_t entry1 = get32(fs->sector_buf + 4);
        if ((entry1 & 0x08000000) != 0) {
            set_error(fs, "write-dirty-failed");
            break;
        }

        fs->substate = SUB_PREP_READ_FAT_SEC;
        start_async_read(fs, fs->search_fat_sector);
        break;
    }

    case SUB_PREP_READ_FSINFO:
        fs->substate = SUB_PREP_PARSE_FSINFO;
        /* fallthrough */

    case SUB_PREP_PARSE_FSINFO: {
        if (get32(fs->sector_buf + 0) != 0x41615252 ||
            get32(fs->sector_buf + 484) != 0x61417272 ||
            get32(fs->sector_buf + 508) != 0xAA550000) {
            set_error(fs, "invalid-fsinfo-signature");
            break;
        }

        fs->fsinfo_free_count = get32(fs->sector_buf + 488);
        fs->fsinfo_next_free = get32(fs->sector_buf + 492);

        if (fs->fsinfo_next_free < 2 || fs->fsinfo_next_free >= fs->total_clusters + 2) {
            fs->fsinfo_next_free = 2;
        }

        fs->substate=SUB_PREP_BACKUP_FSI_CHECK;
        if(fs->backup_boot_sector)start_async_read(fs,fs->partition_lba+fs->backup_boot_sector+fs->fsinfo_sector);
        break;
    }
    case SUB_PREP_BACKUP_FSI_CHECK: {
        if(get32(fs->sector_buf)!=0x41615252u||get32(fs->sector_buf+484)!=0x61417272u||get32(fs->sector_buf+508)!=0xaa550000u){set_error(fs,"invalid-backup-fsinfo-signature");break;}
        fs->current_dir_cluster = fs->root_cluster;
        fs->dir_sector_offset = 0;
        fs->target_slot_found = false;
        fs->target_dir_is_end = false;
        fs->need_next_sec_end_marker = false;
        memset(fs->used_name_mask, 0, sizeof(fs->used_name_mask));
        fs->root_cluster_count = 0;
        fs->visited_root_clusters[0] = fs->root_cluster;
        fs->root_cluster_count = 1;

        fs->substate = SUB_PREP_READ_ROOT_SEC;
        start_async_read(fs, cluster_to_lba(fs, fs->current_dir_cluster, fs->dir_sector_offset));
        break;
    }

    case SUB_PREP_READ_ROOT_SEC:
        fs->substate = SUB_PREP_SCAN_ROOT_SEC;
        /* fallthrough */

    case SUB_PREP_SCAN_ROOT_SEC: {
        bool end_marker_found = false;

        for (int i = 0; i < 16; i++) {
            const uint8_t *entry = fs->sector_buf + i * 32;
            uint8_t first_byte = entry[0];

            if (first_byte == 0x00) {
                if (!fs->target_slot_found) {
                    fs->target_dir_lba = (uint32_t)cluster_to_lba(fs, fs->current_dir_cluster, fs->dir_sector_offset);
                    fs->target_dir_offset = (uint16_t)(i * 32);
                    fs->target_dir_is_end = true;
                    fs->target_slot_found = true;
                }
                end_marker_found = true;
                break;
            }

            if (first_byte == 0xE5) {
                if (!fs->target_slot_found) {
                    fs->target_dir_lba = (uint32_t)cluster_to_lba(fs, fs->current_dir_cluster, fs->dir_sector_offset);
                    fs->target_dir_offset = (uint16_t)(i * 32);
                    fs->target_dir_is_end = false;
                    fs->target_slot_found = true;
                }
                continue;
            }

            if (entry[11] == 0x0F) continue; /* LFN entry */

            /* Check for BFLxxxxx.BBL active file */
            if (memcmp(entry, "BFL", 3) == 0 && memcmp(entry + 8, "BBL", 3) == 0) {
                bool is_digits = true;
                uint32_t num = 0;
                for (int d = 3; d < 8; d++) {
                    if (entry[d] < '0' || entry[d] > '9') {
                        is_digits = false;
                        break;
                    }
                    num = num * 10 + (uint32_t)(entry[d] - '0');
                }
                if (is_digits && num < 1024) {
                    fs->used_name_mask[num / 8] |= (uint8_t)(1 << (num % 8));
                }
            }
        }

        if (end_marker_found) {
            fs->substate = SUB_PREP_CHOOSE_FILENAME;
            /* Advance in next tick */
            break;
        }

        fs->dir_sector_offset++;
        if (fs->dir_sector_offset < fs->sectors_per_cluster) {
            fs->substate = SUB_PREP_READ_ROOT_SEC;
            start_async_read(fs, cluster_to_lba(fs, fs->current_dir_cluster, fs->dir_sector_offset));
        } else {
            /* Need next cluster in root directory chain */
            fs->dir_sector_offset = 0;
            fs->substate = SUB_PREP_READ_ROOT_FAT_NEXT;
            start_async_read(fs, fat_cluster_to_lba(fs, 1, fs->current_dir_cluster));
        }
        break;
    }

    case SUB_PREP_READ_ROOT_FAT_NEXT:
        fs->substate = SUB_PREP_PARSE_ROOT_FAT_NEXT;
        /* fallthrough */

    case SUB_PREP_PARSE_ROOT_FAT_NEXT: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);

        if (fs->num_fats == 2) {
            fs->substate = SUB_PREP_READ_ROOT_FAT2_NEXT;
            start_async_read(fs, fat_cluster_to_lba(fs, 2, fs->current_dir_cluster));
        } else {
            fs->substate = SUB_PREP_CHECK_ROOT_FAT2_NEXT;
        }
        break;
    }

    case SUB_PREP_READ_ROOT_FAT2_NEXT:
        fs->substate = SUB_PREP_CHECK_ROOT_FAT2_NEXT;
        /* fallthrough */

    case SUB_PREP_CHECK_ROOT_FAT2_NEXT: {
        if (fs->num_fats == 2) {
            if (memcmp(fs->sector_buf, fs->fat_staging_buf, FATLOG_SECTOR_SIZE) != 0) {
                set_error(fs, "FAT-mirror-mismatch");
                break;
            }
        }

        uint16_t off = fat_cluster_to_offset(fs->current_dir_cluster);
        uint32_t next_clus = get32(fs->fat_staging_buf + off) & 0x0FFFFFFF;

        if (next_clus >= 0x0FFFFFF8) {
            /* End of root cluster chain */
            fs->substate = SUB_PREP_CHOOSE_FILENAME;
            break;
        }

        if (next_clus < 2 || next_clus >= fs->total_clusters + 2) {
            set_error(fs, "invalid-root-cluster-chain");
            break;
        }

        /* Cycle detection */
        for (uint8_t i = 0; i < fs->root_cluster_count; i++) {
            if (fs->visited_root_clusters[i] == next_clus) {
                set_error(fs, "root-directory-cycle");
                break;
            }
        }
        if (fs->phase == FATLOG_ERROR) break;

        if (fs->root_cluster_count >= 16) {
            set_error(fs, "root-chain-too-long");
            break;
        }

        fs->visited_root_clusters[fs->root_cluster_count++] = next_clus;
        fs->current_dir_cluster = next_clus;

        fs->substate = SUB_PREP_READ_ROOT_SEC;
        start_async_read(fs, cluster_to_lba(fs, fs->current_dir_cluster, fs->dir_sector_offset));
        break;
    }

    case SUB_PREP_CHOOSE_FILENAME: {
        uint32_t chosen_num = 0xFFFFFFFF;
        for (uint32_t n = 1; n < 1024; n++) {
            if (!(fs->used_name_mask[n / 8] & (1 << (n % 8)))) {
                chosen_num = n;
                break;
            }
        }

        if (chosen_num == 0xFFFFFFFF) {
            set_error(fs, "all-filenames-exhausted");
            break;
        }

        if (!fs->target_slot_found) {
            set_error(fs, "root-directory-full");
            break;
        }

        fs->bfl_number = chosen_num;
        memcpy(fs->filename,"BFL00000.BBL",13);
        for(unsigned digit=0,value=chosen_num;digit<5;digit++,value/=10)fs->filename[7-digit]=(char)('0'+value%10);

        /* Start FAT scan for first free cluster */
        uint32_t hint = fs->fsinfo_next_free;
        if (hint < 2 || hint >= fs->total_clusters + 2) {
            hint = 2;
        }

        fs->search_fat_cluster = hint;
        fs->search_fat_sector = (uint32_t)fat_cluster_to_lba(fs, 1, hint);
        fs->fat_scan_start_sector = fs->search_fat_sector;
        fs->fat_scanned_count = 0;

        fs->substate = SUB_PREP_READ_FAT_SEC;
        start_async_read(fs, fs->search_fat_sector);
        break;
    }

    case SUB_PREP_READ_FAT_SEC:
        fs->substate = SUB_PREP_SCAN_FAT_SEC;
        /* fallthrough */

    case SUB_PREP_SCAN_FAT_SEC: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);

        if (fs->num_fats == 2) {
            uint64_t fat2_sec = (uint64_t)fs->fat2_lba + (fs->search_fat_sector - fs->fat1_lba);
            fs->substate = SUB_PREP_READ_FAT2_SEC;
            start_async_read(fs, fat2_sec);
        } else {
            fs->substate = SUB_PREP_CHECK_FAT2_SEC;
        }
        break;
    }

    case SUB_PREP_READ_FAT2_SEC:
        fs->substate = SUB_PREP_CHECK_FAT2_SEC;
        /* fallthrough */

    case SUB_PREP_CHECK_FAT2_SEC: {
        if (fs->num_fats == 2) {
            if (memcmp(fs->sector_buf, fs->fat_staging_buf, FATLOG_SECTOR_SIZE) != 0) {
                set_error(fs, "FAT-mirror-mismatch");
                break;
            }
        }

        uint32_t found_cluster = 0;
        uint32_t sec_first_cluster = (uint32_t)(((uint64_t)(fs->search_fat_sector - fs->fat1_lba) * FATLOG_SECTOR_SIZE) / 4);

        for (int i = 0; i < 128; i++) {
            uint32_t cluster_candidate = sec_first_cluster + (uint32_t)i;
            if (cluster_candidate < 2 || cluster_candidate >= fs->total_clusters + 2) continue;
            uint32_t val = get32(fs->fat_staging_buf + i * 4) & 0x0FFFFFFF;
            if (val == 0x00000000) {
                found_cluster = cluster_candidate;
                break;
            }
        }

        if (found_cluster != 0) {
            fs->start_cluster = found_cluster;
            fs->current_cluster = found_cluster;
            fs->cluster_sec_offset = 0;

            if(!fs->dirty_started){fs->substate=SUB_PREP_LOAD_DIRTY;start_async_read(fs,fs->fat1_lba);break;}
            /* Modify entry in fat_staging_buf preserving high nibble */
            uint16_t off = fat_cluster_to_offset(found_cluster);
            uint32_t old_val = get32(fs->fat_staging_buf + off);
            put32(fs->fat_staging_buf + off, (old_val & 0xF0000000) | 0x0FFFFFFF);

            fs->substate = SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT1;
            start_async_write(fs, fs->search_fat_sector, fs->fat_staging_buf);
        } else {
            fs->search_fat_sector++;
            uint32_t max_fat_sector = fs->fat1_lba + fs->fat_size_sectors;
            if (fs->search_fat_sector >= max_fat_sector) {
                fs->search_fat_sector = fs->fat1_lba;
            }

            fs->fat_scanned_count++;
            if (fs->fat_scanned_count >= fs->fat_size_sectors) {
                set_error(fs, "no-free-clusters");
                break;
            }

            fs->substate = SUB_PREP_READ_FAT_SEC;
            start_async_read(fs, fs->search_fat_sector);
        }
        break;
    }

    case SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT1:
        fs->substate = SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT1;
        start_async_read(fs, fs->search_fat_sector);
        break;

    case SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT1: {
        uint16_t offset_in_sec = fat_cluster_to_offset(fs->start_cluster);
        uint32_t val = get32(fs->sector_buf + offset_in_sec) & 0x0FFFFFFF;
        if (val != 0x0FFFFFFF) {
            set_error(fs, "FAT1-cluster-write-failed");
            break;
        }

        if (fs->num_fats == 2) {
            uint64_t fat2_sec = (uint64_t)fs->fat2_lba + (fs->search_fat_sector - fs->fat1_lba);
            fs->substate = SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT2;
            start_async_write(fs, fat2_sec, fs->fat_staging_buf);
        } else {
            fs->substate = SUB_PREP_READ_TARGET_DIR_SEC;
            start_async_read(fs, fs->target_dir_lba);
        }
        break;
    }

    case SUB_PREP_READ_VERIFY_FIRST_CLUSTER_FAT2: {
        uint64_t fat2_sec = (uint64_t)fs->fat2_lba + (fs->search_fat_sector - fs->fat1_lba);
        fs->substate = SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT2;
        start_async_read(fs, fat2_sec);
        break;
    }

    case SUB_PREP_CHECK_VERIFY_FIRST_CLUSTER_FAT2: {
        uint16_t offset_in_sec = fat_cluster_to_offset(fs->start_cluster);
        uint32_t val = get32(fs->sector_buf + offset_in_sec) & 0x0FFFFFFF;
        if (val != 0x0FFFFFFF) {
            set_error(fs, "FAT2-cluster-write-failed");
            break;
        }

        fs->substate = SUB_PREP_READ_TARGET_DIR_SEC;
        start_async_read(fs, fs->target_dir_lba);
        break;
    }

    case SUB_PREP_READ_TARGET_DIR_SEC:
        fs->substate = SUB_PREP_WRITE_TARGET_DIR_SEC;
        /* fallthrough */

    case SUB_PREP_WRITE_TARGET_DIR_SEC: {
        uint8_t *entry = fs->sector_buf + fs->target_dir_offset;

        if(entry[0]!=0 && entry[0]!=0xe5){set_error(fs,"directory-slot-changed");break;}
        memset(entry,0,32);
        /* Copy 8.3 filename: "BFLxxxxx", "BBL" */
        memcpy(entry, fs->filename, 8);
        memcpy(entry + 8, "BBL", 3);

        entry[11] = 0x20; /* Attribute: Archive */
        put16(entry + 16, 0x0021 /* 1980-01-01: no RTC, not an asserted recording date */); /* CrtDate */
        put16(entry + 18, 0x0021 /* 1980-01-01: no RTC, not an asserted recording date */); /* LstAccDate */
        put16(entry + 20, (uint16_t)(fs->start_cluster >> 16)); /* FstClusHI */
        put16(entry + 24, 0x0021 /* 1980-01-01: no RTC, not an asserted recording date */); /* WrtDate */
        put16(entry + 26, (uint16_t)(fs->start_cluster & 0xFFFF)); /* FstClusLO */
        put32(entry + 28, 0); /* FileSize initially 0 */

        /* Preserve end marker 0x00 if needed */
        if (fs->target_dir_is_end) {
            if (fs->target_dir_offset + 32 < FATLOG_SECTOR_SIZE) {
                memset(fs->sector_buf + fs->target_dir_offset + 32, 0, 32);
            } else if (fs->target_dir_offset + 32 == FATLOG_SECTOR_SIZE) {
                fs->need_next_sec_end_marker = fs->target_dir_lba+1 < fs->data_lba+(fs->root_cluster-2)*fs->sectors_per_cluster+fs->sectors_per_cluster;
            }
        }

        fs->substate = SUB_PREP_READ_VERIFY_DIR_SEC;
        start_async_write(fs, fs->target_dir_lba, fs->sector_buf);
        break;
    }

    case SUB_PREP_READ_VERIFY_DIR_SEC:
        fs->substate = SUB_PREP_CHECK_VERIFY_DIR_SEC;
        start_async_read(fs, fs->target_dir_lba);
        break;

    case SUB_PREP_CHECK_VERIFY_DIR_SEC: {
        const uint8_t *entry = fs->sector_buf + fs->target_dir_offset;
        if (memcmp(entry, fs->filename, 8) != 0 || memcmp(entry + 8, "BBL", 3) != 0) {
            set_error(fs, "dir-entry-write-failed");
            break;
        }

        if (fs->need_next_sec_end_marker) {
            fs->substate = SUB_PREP_READ_NEXT_DIR_SEC;
            start_async_read(fs, fs->target_dir_lba + 1);
        } else {
            fs->substate = SUB_PREP_READ_FSINFO_FOR_UPDATE;
            start_async_read(fs, fs->partition_lba + fs->fsinfo_sector);
        }
        break;
    }

    case SUB_PREP_READ_NEXT_DIR_SEC:
        fs->substate = SUB_PREP_WRITE_NEXT_DIR_SEC;
        /* fallthrough */

    case SUB_PREP_WRITE_NEXT_DIR_SEC: {
        memset(fs->sector_buf, 0, 32);
        fs->substate = SUB_PREP_READ_VERIFY_NEXT_DIR_SEC;
        start_async_write(fs, fs->target_dir_lba + 1, fs->sector_buf);
        break;
    }

    case SUB_PREP_READ_VERIFY_NEXT_DIR_SEC:
        fs->substate = SUB_PREP_CHECK_VERIFY_NEXT_DIR_SEC;
        start_async_read(fs, fs->target_dir_lba + 1);
        break;

    case SUB_PREP_CHECK_VERIFY_NEXT_DIR_SEC: {
        if (fs->sector_buf[0] != 0x00) {
            set_error(fs, "dir-end-marker-write-failed");
            break;
        }

        fs->substate = SUB_PREP_READ_FSINFO_FOR_UPDATE;
        start_async_read(fs, fs->partition_lba + fs->fsinfo_sector);
        break;
    }

    case SUB_PREP_READ_FSINFO_FOR_UPDATE:
        fs->substate = SUB_PREP_WRITE_FSINFO;
        /* fallthrough */

    case SUB_PREP_WRITE_FSINFO: {
        if (fs->fsinfo_free_count != 0xFFFFFFFF && fs->fsinfo_free_count > 0) {
            fs->fsinfo_free_count--;
        }
        fs->fsinfo_next_free = fs->start_cluster + 1;

        fs->fsinfo_free_count=UINT32_MAX;fs->fsinfo_next_free=UINT32_MAX;
        put32(fs->sector_buf + 488, fs->fsinfo_free_count);
        put32(fs->sector_buf + 492, fs->fsinfo_next_free);

        fs->substate = SUB_PREP_READ_VERIFY_FSINFO;
        start_async_write(fs, fs->partition_lba + fs->fsinfo_sector, fs->sector_buf);
        break;
    }

    case SUB_PREP_READ_VERIFY_FSINFO:
        fs->substate = SUB_PREP_CHECK_VERIFY_FSINFO;
        start_async_read(fs, fs->partition_lba + fs->fsinfo_sector);
        break;

    case SUB_PREP_CHECK_VERIFY_FSINFO: {
        if (get32(fs->sector_buf + 492) != fs->fsinfo_next_free) {
            set_error(fs, "fsinfo-write-failed");
            break;
        }

        if(fs->backup_boot_sector){fs->fsinfo_return_close=false;fs->substate=SUB_BACKUP_FSI_WRITE;start_async_read(fs,fs->partition_lba+fs->backup_boot_sector+fs->fsinfo_sector);break;}
        fs->substate = SUB_PREP_FINISH;
        break;
    }

    case SUB_PREP_FINISH:
        fs->phase = FATLOG_READY;
        fs->substate = SUB_IDLE;
        break;

    /* --- WRITING Phase --- */

    case SUB_WRITE_CHECK_CLUSTER:
        if (fs->cluster_sec_offset >= fs->sectors_per_cluster) {
            /* Current cluster full; search and link next cluster */
            uint32_t hint = fs->fsinfo_next_free;
            if (hint < 2 || hint >= fs->total_clusters + 2) hint = 2;

            fs->search_fat_cluster = hint;
            fs->search_fat_sector = (uint32_t)fat_cluster_to_lba(fs, 1, hint);
            fs->fat_scan_start_sector = fs->search_fat_sector;
            fs->fat_scanned_count = 0;

            fs->substate = SUB_WRITE_READ_FAT_SEC;
            start_async_read(fs, fs->search_fat_sector);
        } else {
            fs->substate = SUB_WRITE_DO_DATA_WRITE;
            start_async_write(fs, cluster_to_lba(fs, fs->current_cluster, fs->cluster_sec_offset), fs->write_buf);
        }
        break;

    case SUB_WRITE_READ_FAT_SEC:
        fs->substate = SUB_WRITE_SCAN_FAT_SEC;
        /* fallthrough */

    case SUB_WRITE_SCAN_FAT_SEC: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);

        if (fs->num_fats == 2) {
            uint64_t fat2_sec = (uint64_t)fs->fat2_lba + (fs->search_fat_sector - fs->fat1_lba);
            fs->substate = SUB_WRITE_READ_FAT2_SEC;
            start_async_read(fs, fat2_sec);
        } else {
            fs->substate = SUB_WRITE_CHECK_FAT2_SEC;
        }
        break;
    }

    case SUB_WRITE_READ_FAT2_SEC:
        fs->substate = SUB_WRITE_CHECK_FAT2_SEC;
        /* fallthrough */

    case SUB_WRITE_CHECK_FAT2_SEC: {
        if (fs->num_fats == 2) {
            if (memcmp(fs->sector_buf, fs->fat_staging_buf, FATLOG_SECTOR_SIZE) != 0) {
                set_error(fs, "FAT-mirror-mismatch");
                break;
            }
        }

        uint32_t found_cluster = 0;
        uint32_t sec_first_cluster = (uint32_t)(((uint64_t)(fs->search_fat_sector - fs->fat1_lba) * FATLOG_SECTOR_SIZE) / 4);

        for (int i = 0; i < 128; i++) {
            uint32_t cluster_candidate = sec_first_cluster + (uint32_t)i;
            if (cluster_candidate < 2 || cluster_candidate >= fs->total_clusters + 2) continue;
            uint32_t val = get32(fs->fat_staging_buf + i * 4) & 0x0FFFFFFF;
            if (val == 0x00000000) {
                found_cluster = cluster_candidate;
                break;
            }
        }

        if (found_cluster != 0) {
            fs->link_new_cluster = found_cluster;
            fs->link_prev_cluster = fs->current_cluster;

            /* STEP 1: Reserve new_cluster with EOC in FAT1 (and FAT2) FIRST */
            fs->substate = SUB_WRITE_READ_NEW_FAT1;
            uint64_t new_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_new_cluster);
            start_async_read(fs, new_fat1_lba);
        } else {
            fs->search_fat_sector++;
            uint32_t max_fat_sector = fs->fat1_lba + fs->fat_size_sectors;
            if (fs->search_fat_sector >= max_fat_sector) {
                fs->search_fat_sector = fs->fat1_lba;
            }

            fs->fat_scanned_count++;
            if (fs->fat_scanned_count >= fs->fat_size_sectors) {
                set_error(fs, "disk-full");
                break;
            }

            fs->substate = SUB_WRITE_READ_FAT_SEC;
            start_async_read(fs, fs->search_fat_sector);
        }
        break;
    }

    /* STEP 1: Reserve new cluster as EOC */
    case SUB_WRITE_READ_NEW_FAT1:
        fs->substate = SUB_WRITE_SET_NEW_FAT1;
        /* fallthrough */

    case SUB_WRITE_SET_NEW_FAT1: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);
        uint16_t off = fat_cluster_to_offset(fs->link_new_cluster);
        uint32_t old_val = get32(fs->fat_staging_buf + off);
        put32(fs->fat_staging_buf + off, (old_val & 0xF0000000) | 0x0FFFFFFF);

        uint64_t new_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_new_cluster);
        fs->substate = SUB_WRITE_READ_VERIFY_NEW_FAT1;
        start_async_write(fs, new_fat1_lba, fs->fat_staging_buf);
        break;
    }

    case SUB_WRITE_READ_VERIFY_NEW_FAT1: {
        uint64_t new_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_new_cluster);
        fs->substate = SUB_WRITE_CHECK_VERIFY_NEW_FAT1;
        start_async_read(fs, new_fat1_lba);
        break;
    }

    case SUB_WRITE_CHECK_VERIFY_NEW_FAT1: {
        uint16_t off = fat_cluster_to_offset(fs->link_new_cluster);
        if ((get32(fs->sector_buf + off) & 0x0FFFFFFF) != 0x0FFFFFFF) {
            set_error(fs, "FAT1-eoc-write-failed");
            break;
        }

        if (fs->num_fats == 2) {
            uint64_t new_fat2_lba = fat_cluster_to_lba(fs, 2, fs->link_new_cluster);
            fs->substate = SUB_WRITE_READ_VERIFY_NEW_FAT2;
            start_async_write(fs, new_fat2_lba, fs->fat_staging_buf);
        } else {
            /* Move to STEP 2: Link prev cluster */
            uint64_t prev_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_prev_cluster);
            fs->substate = SUB_WRITE_READ_PREV_FAT1;
            start_async_read(fs, prev_fat1_lba);
        }
        break;
    }

    case SUB_WRITE_READ_VERIFY_NEW_FAT2: {
        uint64_t new_fat2_lba = fat_cluster_to_lba(fs, 2, fs->link_new_cluster);
        fs->substate = SUB_WRITE_CHECK_VERIFY_NEW_FAT2;
        start_async_read(fs, new_fat2_lba);
        break;
    }

    case SUB_WRITE_CHECK_VERIFY_NEW_FAT2: {
        uint16_t off = fat_cluster_to_offset(fs->link_new_cluster);
        if ((get32(fs->sector_buf + off) & 0x0FFFFFFF) != 0x0FFFFFFF) {
            set_error(fs, "FAT2-eoc-write-failed");
            break;
        }

        /* Move to STEP 2: Link prev cluster */
        uint64_t prev_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_prev_cluster);
        fs->substate = SUB_WRITE_READ_PREV_FAT1;
        start_async_read(fs, prev_fat1_lba);
        break;
    }

    /* STEP 2: Link old cluster to new cluster */
    case SUB_WRITE_READ_PREV_FAT1:
        fs->substate = SUB_WRITE_LINK_PREV_FAT1;
        /* fallthrough */

    case SUB_WRITE_LINK_PREV_FAT1:
        memcpy(fs->fat_staging_buf,fs->sector_buf,512);fs->substate=SUB_WRITE_CHECK_PREV_FAT2;
        if(fs->num_fats==2)start_async_read(fs,fat_cluster_to_lba(fs,2,fs->link_prev_cluster));
        break;
    case SUB_WRITE_CHECK_PREV_FAT2:
        if(fs->num_fats==2&&memcmp(fs->sector_buf,fs->fat_staging_buf,512)){set_error(fs,"FAT-mirror-mismatch");break;}
        if((get32(fs->sector_buf+fat_cluster_to_offset(fs->link_prev_cluster))&0x0fffffffu)<0x0ffffff8u){set_error(fs,"owned-tail-changed");break;}
        fs->substate=SUB_WRITE_COMMIT_PREV;break;
    case SUB_WRITE_COMMIT_PREV: {
        memcpy(fs->fat_staging_buf, fs->sector_buf, FATLOG_SECTOR_SIZE);
        uint16_t off = fat_cluster_to_offset(fs->link_prev_cluster);
        uint32_t old_val = get32(fs->fat_staging_buf + off);
        put32(fs->fat_staging_buf + off, (old_val & 0xF0000000) | (fs->link_new_cluster & 0x0FFFFFFF));

        uint64_t prev_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_prev_cluster);
        fs->substate = SUB_WRITE_READ_VERIFY_PREV_FAT1;
        start_async_write(fs, prev_fat1_lba, fs->fat_staging_buf);
        break;
    }

    case SUB_WRITE_READ_VERIFY_PREV_FAT1: {
        uint64_t prev_fat1_lba = fat_cluster_to_lba(fs, 1, fs->link_prev_cluster);
        fs->substate = SUB_WRITE_CHECK_VERIFY_PREV_FAT1;
        start_async_read(fs, prev_fat1_lba);
        break;
    }

    case SUB_WRITE_CHECK_VERIFY_PREV_FAT1: {
        uint16_t off = fat_cluster_to_offset(fs->link_prev_cluster);
        if ((get32(fs->sector_buf + off) & 0x0FFFFFFF) != (fs->link_new_cluster & 0x0FFFFFFF)) {
            set_error(fs, "FAT1-link-write-failed");
            break;
        }

        if (fs->num_fats == 2) {
            uint64_t prev_fat2_lba = fat_cluster_to_lba(fs, 2, fs->link_prev_cluster);
            fs->substate = SUB_WRITE_READ_VERIFY_PREV_FAT2;
            start_async_write(fs, prev_fat2_lba, fs->fat_staging_buf);
        } else {
            fs->current_cluster = fs->link_new_cluster;
            fs->cluster_sec_offset = 0;
            fs->substate = SUB_WRITE_DO_DATA_WRITE;
            start_async_write(fs, cluster_to_lba(fs, fs->current_cluster, fs->cluster_sec_offset), fs->write_buf);
        }
        break;
    }

    case SUB_WRITE_READ_VERIFY_PREV_FAT2: {
        uint64_t prev_fat2_lba = fat_cluster_to_lba(fs, 2, fs->link_prev_cluster);
        fs->substate = SUB_WRITE_CHECK_VERIFY_PREV_FAT2;
        start_async_read(fs, prev_fat2_lba);
        break;
    }

    case SUB_WRITE_CHECK_VERIFY_PREV_FAT2: {
        uint16_t off = fat_cluster_to_offset(fs->link_prev_cluster);
        if ((get32(fs->sector_buf + off) & 0x0FFFFFFF) != (fs->link_new_cluster & 0x0FFFFFFF)) {
            set_error(fs, "FAT2-link-write-failed");
            break;
        }

        fs->current_cluster = fs->link_new_cluster;
        fs->cluster_sec_offset = 0;
        fs->substate = SUB_WRITE_DO_DATA_WRITE;
        start_async_write(fs, cluster_to_lba(fs, fs->current_cluster, fs->cluster_sec_offset), fs->write_buf);
        break;
    }

    case SUB_WRITE_DO_DATA_WRITE: {
        fs->substate = SUB_WRITE_READ_VERIFY_DATA;
        start_async_read(fs, cluster_to_lba(fs, fs->current_cluster, fs->cluster_sec_offset));
        break;
    }

    case SUB_WRITE_READ_VERIFY_DATA: {
        fs->substate = SUB_WRITE_CHECK_VERIFY_DATA;
        start_async_read(fs, cluster_to_lba(fs, fs->current_cluster, fs->cluster_sec_offset));
        break;
    }

    case SUB_WRITE_CHECK_VERIFY_DATA:
        if (memcmp(fs->sector_buf, fs->write_buf, FATLOG_SECTOR_SIZE) != 0) {
            set_error(fs, "data-write-verification-failed");
            break;
        }

        fs->bytes_written += fs->write_used_bytes;
        fs->cluster_sec_offset++;
        fs->phase = FATLOG_READY;
        fs->substate = SUB_IDLE;
        break;

    /* --- CLOSING Phase --- */

    case SUB_CLOSE_READ_DIR_SEC:
        fs->substate = SUB_CLOSE_WRITE_DIR_SEC;
        /* fallthrough */

    case SUB_CLOSE_WRITE_DIR_SEC: {
        uint8_t *entry = fs->sector_buf + fs->target_dir_offset;
        if(memcmp(entry,fs->filename,8)||memcmp(entry+8,"BBL",3)||get16(entry+26)!=(uint16_t)fs->start_cluster||get16(entry+20)!=(uint16_t)(fs->start_cluster>>16)){set_error(fs,"owned-directory-entry-changed");break;}
        put32(entry + 28, (uint32_t)fs->bytes_written);

        fs->substate = SUB_CLOSE_READ_VERIFY_DIR;
        start_async_write(fs, fs->target_dir_lba, fs->sector_buf);
        break;
    }

    case SUB_CLOSE_READ_VERIFY_DIR:
        fs->substate = SUB_CLOSE_CHECK_VERIFY_DIR;
        start_async_read(fs, fs->target_dir_lba);
        break;

    case SUB_CLOSE_CHECK_VERIFY_DIR: {
        const uint8_t *entry = fs->sector_buf + fs->target_dir_offset;
        if (get32(entry + 28) != (uint32_t)fs->bytes_written) {
            set_error(fs, "dir-size-update-failed");
            break;
        }

        fs->substate = SUB_CLOSE_READ_FSINFO;
        start_async_read(fs, fs->partition_lba + fs->fsinfo_sector);
        break;
    }

    case SUB_CLOSE_READ_FSINFO:
        fs->substate = SUB_CLOSE_WRITE_FSINFO;
        /* fallthrough */

    case SUB_CLOSE_WRITE_FSINFO: {
        fs->fsinfo_free_count=UINT32_MAX;fs->fsinfo_next_free=UINT32_MAX;
        put32(fs->sector_buf + 488, fs->fsinfo_free_count);
        put32(fs->sector_buf + 492, fs->fsinfo_next_free);

        fs->substate = SUB_CLOSE_READ_VERIFY_FSINFO;
        start_async_write(fs, fs->partition_lba + fs->fsinfo_sector, fs->sector_buf);
        break;
    }

    case SUB_CLOSE_READ_VERIFY_FSINFO:
        fs->substate = SUB_CLOSE_CHECK_VERIFY_FSINFO;
        start_async_read(fs, fs->partition_lba + fs->fsinfo_sector);
        break;

    case SUB_CLOSE_CHECK_VERIFY_FSINFO: {
        if (get32(fs->sector_buf + 492) != fs->fsinfo_next_free) {
            set_error(fs, "fsinfo-close-update-failed");
            break;
        }

        if(fs->backup_boot_sector){fs->fsinfo_return_close=true;fs->substate=SUB_BACKUP_FSI_WRITE;start_async_read(fs,fs->partition_lba+fs->backup_boot_sector+fs->fsinfo_sector);break;}
        fs->substate = SUB_CLOSE_READ_FAT1_SEC0;
        start_async_read(fs, fs->fat1_lba);
        break;
    }
    case SUB_BACKUP_FSI_WRITE:
        if(get32(fs->sector_buf)!=0x41615252u||get32(fs->sector_buf+484)!=0x61417272u||get32(fs->sector_buf+508)!=0xaa550000u){set_error(fs,"backup-fsinfo-changed");break;}
        put32(fs->sector_buf+488,UINT32_MAX);put32(fs->sector_buf+492,UINT32_MAX);
        fs->substate=SUB_BACKUP_FSI_VERIFY;start_async_write(fs,fs->partition_lba+fs->backup_boot_sector+fs->fsinfo_sector,fs->sector_buf);break;
    case SUB_BACKUP_FSI_VERIFY:
        fs->substate=SUB_BACKUP_FSI_DONE;start_async_read(fs,fs->partition_lba+fs->backup_boot_sector+fs->fsinfo_sector);break;
    case SUB_BACKUP_FSI_DONE:
        if(fs->fsinfo_return_close){fs->substate=SUB_CLOSE_READ_FAT1_SEC0;start_async_read(fs,fs->fat1_lba);}
        else fs->substate=SUB_PREP_FINISH;
        break;

    case SUB_CLOSE_READ_FAT1_SEC0:
        fs->substate = SUB_CLOSE_WRITE_CLEAN_FAT1;
        /* fallthrough */

    case SUB_CLOSE_WRITE_CLEAN_FAT1:
        memcpy(fs->fat_staging_buf,fs->sector_buf,512);fs->substate=SUB_CLOSE_CHECK_FAT2;
        if(fs->num_fats==2)start_async_read(fs,fs->fat2_lba);
        break;
    case SUB_CLOSE_CHECK_FAT2:
        if(fs->num_fats==2&&memcmp(fs->sector_buf,fs->fat_staging_buf,512)){set_error(fs,"FAT-mirror-mismatch");break;}
        fs->substate=SUB_CLOSE_COMMIT_CLEAN;break;
    case SUB_CLOSE_COMMIT_CLEAN: {
        uint32_t val = get32(fs->sector_buf + 4);
        /* Restore Clean Shutdown bit (bit 27 = 1) maintaining high nibble */
        uint32_t new_val = (val & 0xF0000000) | (val & 0x0FFFFFFF) | 0x08000000;
        put32(fs->sector_buf + 4, new_val);

        fs->substate = SUB_CLOSE_READ_VERIFY_CLEAN_FAT1;
        start_async_write(fs, fs->fat1_lba, fs->sector_buf);
        break;
    }

    case SUB_CLOSE_READ_VERIFY_CLEAN_FAT1:
        fs->substate = SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT1;
        start_async_read(fs, fs->fat1_lba);
        break;

    case SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT1: {
        uint32_t entry1 = get32(fs->sector_buf + 4);
        if ((entry1 & 0x08000000) == 0) {
            set_error(fs, "restore-clean-failed");
            break;
        }

        if (fs->num_fats == 2) {
            /* Prepare FAT2 clean write */
            fs->substate = SUB_CLOSE_WRITE_CLEAN_FAT2;
            start_async_write(fs, fs->fat2_lba, fs->sector_buf);
        } else {
            fs->substate = SUB_CLOSE_FINISH;
        }
        break;
    }

    case SUB_CLOSE_WRITE_CLEAN_FAT2:
        fs->substate = SUB_CLOSE_READ_VERIFY_CLEAN_FAT2;
        /* fallthrough */

    case SUB_CLOSE_READ_VERIFY_CLEAN_FAT2:
        fs->substate = SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT2;
        start_async_read(fs, fs->fat2_lba);
        break;

    case SUB_CLOSE_CHECK_VERIFY_CLEAN_FAT2: {
        uint32_t entry1 = get32(fs->sector_buf + 4);
        if ((entry1 & 0x08000000) == 0) {
            set_error(fs, "restore-clean-failed");
            break;
        }

        fs->substate = SUB_CLOSE_FINISH;
        break;
    }

    case SUB_CLOSE_FINISH:
        fs->phase = FATLOG_DONE;
        fs->substate = SUB_IDLE;
        break;

    default:
        set_error(fs, "unknown-substate");
        break;
    }

    return (int)fs->phase;
}
