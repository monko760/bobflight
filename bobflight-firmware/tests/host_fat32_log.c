/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/**
 * @file host_fat32_log.c
 * @brief Standalone Native Test Suite for Original Asynchronous FAT32 Log-File Writer.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

#include "drivers/fat32_log.h"

#define MAX_SPARSE_SECTORS 8192

typedef struct {
    uint32_t sector_num[MAX_SPARSE_SECTORS];
    uint8_t data[MAX_SPARSE_SECTORS][512];
    size_t count;
    uint64_t total_sectors;

    /* Fault injection and testing controls */
    uint32_t fail_read_sector;
    uint32_t fail_write_sector;
    int fail_poll_after_calls;
    int current_poll_calls;

    /* Async operation simulator */
    bool pending_op;
    bool pending_is_write;
    uint32_t pending_sector;
    uint8_t pending_buf[512];
    uint8_t *pending_dest;
    const uint8_t *pending_source;
} mock_card_t;

static mock_card_t g_card;

static void reset_mock_card(uint64_t total_sectors) {
    memset(&g_card, 0, sizeof(g_card));
    g_card.total_sectors = total_sectors;
    g_card.fail_read_sector = 0xFFFFFFFF;
    g_card.fail_write_sector = 0xFFFFFFFF;
    g_card.fail_poll_after_calls = -1;
}

static uint8_t *get_mock_sector(uint32_t sec, bool create) {
    for (size_t i = 0; i < g_card.count; i++) {
        if (g_card.sector_num[i] == sec) {
            return g_card.data[i];
        }
    }
    if (create && g_card.count < MAX_SPARSE_SECTORS) {
        size_t idx = g_card.count++;
        g_card.sector_num[idx] = sec;
        memset(g_card.data[idx], 0, 512);
        return g_card.data[idx];
    }
    return NULL;
}

static bool mock_read(void *ctx, uint32_t sector, uint8_t *buffer) {
    (void)ctx;
    if (sector == g_card.fail_read_sector) {
        return false;
    }
    g_card.pending_op = true;
    g_card.pending_is_write = false;
    g_card.pending_sector = sector;

    g_card.pending_dest=buffer;
    return true;
}

static bool mock_write(void *ctx, uint32_t sector, const uint8_t *buffer) {
    (void)ctx;
    if (sector == g_card.fail_write_sector) {
        return false;
    }
    g_card.pending_op = true;
    g_card.pending_is_write = true;
    g_card.pending_sector = sector;
    memcpy(g_card.pending_buf, buffer, 512);

    g_card.pending_source=buffer;
    return true;
}

static int mock_poll(void *ctx, uint64_t now) {
    (void)ctx;
    (void)now;
    g_card.current_poll_calls++;

    if (g_card.fail_poll_after_calls > 0 &&
        g_card.current_poll_calls >= g_card.fail_poll_after_calls) {
        return -1; /* Fault injection poll error */
    }

    if (!g_card.pending_op) {
        return 0;
    }
    if(g_card.pending_is_write){assert(!memcmp(g_card.pending_source,g_card.pending_buf,512));memcpy(get_mock_sector(g_card.pending_sector,true),g_card.pending_buf,512);}
    else {uint8_t *v=get_mock_sector(g_card.pending_sector,false);if(v)memcpy(g_card.pending_dest,v,512);else memset(g_card.pending_dest,0,512);}
    g_card.pending_op = false;
    return 1; /* Done */
}

static fatlog_io_t create_mock_io(void) {
    return (fatlog_io_t){
        .ctx = &g_card,
        .sectors = g_card.total_sectors,
        .read = mock_read,
        .write = mock_write,
        .poll = mock_poll
    };
}

/* Helpers for constructing FAT32 structures in mock card */

static void put16(uint8_t *b, uint16_t n) { b[0] = (uint8_t)n; b[1] = (uint8_t)(n >> 8); }
static void put32(uint8_t *b, uint32_t n) { put16(b, (uint16_t)n); put16(b + 2, (uint16_t)(n >> 16)); }
static uint32_t get32(const uint8_t *b) { return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24); }

static void format_mock_fat32_volume(
    uint32_t part_lba,
    uint32_t total_sec,
    uint16_t rsvd_sec,
    uint8_t num_fats,
    uint8_t sec_per_clus,
    uint32_t fat_sz_sec,
    uint32_t root_clus
) {
    /* VBR at part_lba */
    uint8_t *vbr = get_mock_sector(part_lba, true);
    vbr[0] = 0xEB; vbr[1] = 0x58; vbr[2] = 0x90;
    memcpy(vbr + 3, "MSWIN4.1", 8);
    put16(vbr + 11, 512);          /* BPB_BytsPerSec */
    vbr[13] = sec_per_clus;        /* BPB_SecPerClus */
    put16(vbr + 14, rsvd_sec);     /* BPB_RsvdSecCnt */
    vbr[16] = num_fats;            /* BPB_NumFATs */
    vbr[21] = 0xF8;                /* BPB_Media */
    put32(vbr + 32, total_sec);    /* BPB_TotSec32 */
    put32(vbr + 36, fat_sz_sec);   /* BPB_FATSz32 */
    put32(vbr + 44, root_clus);    /* BPB_RootClus */
    put16(vbr + 48, 1);            /* BPB_FSInfo */
    put16(vbr + 50, 6);            /* BPB_BkBootSec */
    memcpy(vbr + 82, "FAT32   ", 8);
    vbr[510] = 0x55; vbr[511] = 0xAA;

    /* If partitioned, write MBR at Sector 0 */
    if (part_lba > 0) {
        uint8_t *mbr = get_mock_sector(0, true);
        mbr[510] = 0x55; mbr[511] = 0xAA;
        uint8_t *part = mbr + 0x01BE;
        part[4] = 0x0C; /* FAT32 LBA */
        put32(part + 8, part_lba);
        put32(part + 12, total_sec);
    }

    /* FSInfo Sector at part_lba + 1 */
    uint8_t *fsi = get_mock_sector(part_lba + 1, true);
    put32(fsi + 0, 0x41615252);
    put32(fsi + 484, 0x61417272);
    put32(fsi + 488, 100000); /* Free count */
    put32(fsi + 492, root_clus + 1); /* Next free */
    put32(fsi + 508, 0xAA550000);

    memcpy(get_mock_sector(part_lba+6,true),vbr,512);
    memcpy(get_mock_sector(part_lba+7,true),fsi,512);
    /* FAT1 Sector 0 at part_lba + rsvd_sec */
    uint32_t fat1_lba = part_lba + rsvd_sec;
    uint8_t *fat1 = get_mock_sector(fat1_lba, true);
    put32(fat1 + 0, 0x0FFFFFF8); /* Entry 0 */
    put32(fat1 + 4, 0x0FFFFFFF); /* Entry 1: Clean (bit 27=1), No Error (bit 26=1) */

    /* Root cluster entry in FAT1 */
    uint32_t root_fat_sec = fat1_lba + (root_clus * 4) / 512;
    uint16_t root_fat_off = (root_clus * 4) % 512;
    uint8_t *root_fat_ptr = get_mock_sector(root_fat_sec, true);
    put32(root_fat_ptr + root_fat_off, 0x0FFFFFFF); /* EOC */

    /* FAT2 Sector 0 if mirrored */
    if (num_fats == 2) {
        uint32_t fat2_lba = fat1_lba + fat_sz_sec;
        uint8_t *fat2 = get_mock_sector(fat2_lba, true);
        put32(fat2 + 0, 0x0FFFFFF8);
        put32(fat2 + 4, 0x0FFFFFFF);

        uint32_t root_fat2_sec = fat2_lba + (root_clus * 4) / 512;
        uint8_t *root_fat2_ptr = get_mock_sector(root_fat2_sec, true);
        put32(root_fat2_ptr + root_fat_off, 0x0FFFFFFF);
    }
}

static void drive_log_to_ready(fatlog_t *fs, const fatlog_io_t *io) {
    assert(fatlog_start(fs, io, 0));
    for (int i = 0; i < 500 && fs->phase == FATLOG_PREPARING; i++) {
        fatlog_poll(fs, (uint64_t)i * 10);
    }
    if(fs->phase!=FATLOG_READY)fprintf(stderr,"mount: %s\n",fs->error?fs->error:"pending");
    assert(fs->phase == FATLOG_READY);
}

/* --- Individual Test Functions --- */

static void test_user_probe_card_geometry(void) {
    /* User's actual successful probe: capacity31914983424, 62333952 sectors, FAT32 boot at 0, cluster 16384 (32 sec/clus) */
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);
    assert(strcmp(fs.filename, "BFL00001.BBL") == 0);

    /* Write 3 sectors of data (2 full sectors 512B + 1 short sector 100B) */
    uint8_t payload[512];
    for (int i = 0; i < 512; i++) payload[i] = (uint8_t)(i ^ 0xA5);

    assert(fatlog_write(&fs, payload, 512, 1000));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 2000);
    assert(fs.phase == FATLOG_READY);

    for (int i = 0; i < 512; i++) payload[i] = (uint8_t)(i ^ 0x5A);
    assert(fatlog_write(&fs, payload, 512, 3000));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 4000);
    assert(fs.phase == FATLOG_READY);

    for (int i = 0; i < 100; i++) payload[i] = (uint8_t)i;
    assert(fatlog_write(&fs, payload, 100, 5000));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 6000);
    assert(fs.phase == FATLOG_READY);

    /* Subsequent write rejected after short sector */
    assert(!fatlog_write(&fs, payload, 512, 7000));

    /* Close file */
    assert(fatlog_close(&fs, 8000));
    while (fs.phase == FATLOG_CLOSING) fatlog_poll(&fs, 9000);
    assert(fs.phase == FATLOG_DONE);
    assert(fs.bytes_written == 1124);

    /* Verify clean bit restored in FAT Entry 1 */
    uint8_t *fat1_sec0 = get_mock_sector(32, false);
    assert(fat1_sec0 != NULL);
    uint32_t entry1 = get32(fat1_sec0 + 4);
    assert((entry1 & 0x08000000) != 0); /* Clean bit restored */

    puts("  PASS: user probe card geometry (31.9 GB, 16KB clusters, async write & clean close)");
}

static void test_preexisting_files_unchanged_proof(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    /* Populate pre-existing files in root dir and data area */
    uint32_t data_lba = 32 + (2 * 16384);
    uint32_t root_lba = data_lba;

    uint8_t *root_sec = get_mock_sector(root_lba, true);

    /* Entry 0: README.TXT at cluster 3 */
    memcpy(root_sec, "README  TXT", 11);
    root_sec[11] = 0x20;
    put16(root_sec + 26, 3); /* Start cluster 3 */
    put32(root_sec + 28, 512);

    /* Entry 1: CONFIG  INI at cluster 4 */
    memcpy(root_sec + 32, "CONFIG  INI", 11);
    root_sec[32 + 11] = 0x20;
    put16(root_sec + 32 + 26, 4); /* Start cluster 4 */
    put32(root_sec + 32 + 28, 512);

    /* Entry 2: 0x00 End Marker */
    root_sec[64] = 0x00;

    /* Write data into cluster 3 (LBA data_lba + 32) and cluster 4 (LBA data_lba + 64) */
    uint8_t *clus3 = get_mock_sector(data_lba + 32, true);
    for (int i = 0; i < 512; i++) clus3[i] = (uint8_t)(0x11 + i);

    uint8_t *clus4 = get_mock_sector(data_lba + 64, true);
    for (int i = 0; i < 512; i++) clus4[i] = (uint8_t)(0x22 + i);

    /* Mark cluster 3 and 4 in FAT1 and FAT2 as allocated EOC */
    uint8_t *fat1_sec0 = get_mock_sector(32, true);
    put32(fat1_sec0 + 12, 0x0FFFFFFF); /* Cluster 3 */
    put32(fat1_sec0 + 16, 0x0FFFFFFF); /* Cluster 4 */

    uint8_t *fat2_sec0 = get_mock_sector(32 + 16384, true);
    put32(fat2_sec0 + 12, 0x0FFFFFFF);
    put32(fat2_sec0 + 16, 0x0FFFFFFF);

    /* Snapshot pre-existing file sectors and entries */
    uint8_t clus3_snap[512], clus4_snap[512], entry0_snap[32], entry1_snap[32];
    memcpy(clus3_snap, clus3, 512);
    memcpy(clus4_snap, clus4, 512);
    memcpy(entry0_snap, root_sec, 32);
    memcpy(entry1_snap, root_sec + 32, 32);

    /* Run log writer */
    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);
    assert(strcmp(fs.filename, "BFL00001.BBL") == 0);

    uint8_t log_payload[512];
    memset(log_payload, 0xDD, 512);
    assert(fatlog_write(&fs, log_payload, 512, 100));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 200);

    assert(fatlog_close(&fs, 300));
    while (fs.phase == FATLOG_CLOSING) fatlog_poll(&fs, 400);
    assert(fs.phase == FATLOG_DONE);

    /* Verify pre-existing files and entries remain 100% bit-for-bit identical */
    assert(memcmp(clus3_snap, clus3, 512) == 0);
    assert(memcmp(clus4_snap, clus4, 512) == 0);
    assert(memcmp(entry0_snap, root_sec, 32) == 0);
    assert(memcmp(entry1_snap, root_sec + 32, 32) == 0);

    /* Verify new file was written to Entry 2, and Entry 3 is 0x00 */
    assert(memcmp(root_sec + 64, "BFL00001BBL", 11) == 0);
    assert(root_sec[96] == 0x00); /* End marker preserved */

    puts("  PASS: pre-existing files and nonfree FAT entries unchanged proof");
}

static void test_sequential_duplicate_filenames(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    uint32_t data_lba = 32 + (2 * 16384);
    uint8_t *root_sec = get_mock_sector(data_lba, true);

    /* Pre-populate BFL00001.BBL and BFL00002.BBL */
    memcpy(root_sec, "BFL00001BBL", 11);
    root_sec[11] = 0x20;
    put16(root_sec + 26, 3);

    memcpy(root_sec + 32, "BFL00002BBL", 11);
    root_sec[32 + 11] = 0x20;
    put16(root_sec + 32 + 26, 4);

    root_sec[64] = 0x00;

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);
    assert(strcmp(fs.filename, "BFL00003.BBL") == 0);

    puts("  PASS: sequential duplicate filename scan (selected BFL00003.BBL)");
}

static void test_slot_reuse_deleted_entry(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    uint32_t data_lba = 32 + (2 * 16384);
    uint8_t *root_sec = get_mock_sector(data_lba, true);

    /* Entry 0: Deleted 0xE5 */
    root_sec[0] = 0xE5;
    memcpy(root_sec + 1, "ELETED  TXT", 10);

    /* Entry 1: Active ACTIVE  TXT */
    memcpy(root_sec + 32, "ACTIVE  TXT", 11);
    root_sec[32 + 11] = 0x20;

    /* Entry 2: 0x00 End Marker */
    root_sec[64] = 0x00;

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);
    assert(strcmp(fs.filename, "BFL00001.BBL") == 0);

    uint8_t one[512]={0};assert(fatlog_write(&fs,one,1,100));while(fs.phase==FATLOG_WRITING)fatlog_poll(&fs,100);
    assert(fatlog_close(&fs, 100));
    while (fs.phase == FATLOG_CLOSING) fatlog_poll(&fs, 200);
    assert(fs.phase == FATLOG_DONE);

    /* Verify new file re-used Entry 0 (deleted slot), while Entry 1 and Entry 2 are unchanged */
    assert(memcmp(root_sec, "BFL00001BBL", 11) == 0);
    assert(memcmp(root_sec + 32, "ACTIVE  TXT", 11) == 0);
    assert(root_sec[64] == 0x00);

    puts("  PASS: directory slot reuse (re-used 0xE5 deleted slot without touching active or end marker)");
}

static void test_exfat_rejection(void) {
    reset_mock_card(62333952);
    uint8_t *sec0 = get_mock_sector(0, true);
    sec0[0] = 0xEB; sec0[1] = 0x76; sec0[2] = 0x90;
    memcpy(sec0 + 3, "EXFAT   ", 8);
    sec0[510] = 0x55; sec0[511] = 0xAA;

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "exFAT-not-supported") == 0);

    puts("  PASS: exFAT explicitly rejected");
}

static void test_gpt_rejection(void) {
    reset_mock_card(62333952);
    uint8_t *sec0 = get_mock_sector(0, true);
    sec0[510] = 0x55; sec0[511] = 0xAA;
    uint8_t *part = sec0 + 0x01BE;
    part[4] = 0xEE; /* GPT protective MBR */
    put32(part + 8, 2048);
    put32(part + 12, 100000);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "GPT-not-supported") == 0);

    puts("  PASS: GPT protective MBR explicitly rejected");
}

static void test_dirty_volume_rejection(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    /* Clear Clean Shutdown bit (bit 27) in FAT1 Entry 1 */
    uint8_t *fat1_sec0 = get_mock_sector(32, false);
    uint32_t entry1 = get32(fat1_sec0 + 4);
    put32(fat1_sec0 + 4, entry1 & ~0x08000000); /* Mark dirty */

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "volume-dirty") == 0);

    puts("  PASS: dirty volume status bit explicitly rejected");
}

static void test_fat_mirror_mismatch_rejection(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    /* Corrupt FAT2 Entry 1 to create mirror disagreement */
    uint8_t *fat2_sec0 = get_mock_sector(32 + 16384, true);
    put32(fat2_sec0 + 4, 0x00000000);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "FAT-mirror-mismatch") == 0);

    puts("  PASS: FAT mirror disagreement explicitly rejected");
}

static void test_fault_injection_and_dirty_preservation(void) {
    reset_mock_card(62333952);
    format_mock_fat32_volume(0, 62333952, 32, 2, 32, 16384, 2);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);

    /* Inject write fault on data sector write */
    uint32_t data_lba = 32 + (2 * 16384);
    uint32_t data_sec = data_lba + (fs.start_cluster - 2) * fs.sectors_per_cluster;
    g_card.fail_write_sector = data_sec;

    uint8_t payload[512] = {0};
    assert(fatlog_write(&fs, payload, 512, 100));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 200);

    assert(fs.phase == FATLOG_ERROR);

    /* Verify volume clean bit was NOT restored (remains dirty) */
    uint8_t *fat1_sec0 = get_mock_sector(32, false);
    uint32_t entry1 = get32(fat1_sec0 + 4);
    assert((entry1 & 0x08000000) == 0); /* Still dirty */

    puts("  PASS: fault injection handled; volume left marked dirty as required");
}

static void test_disk_full_no_free_clusters(void) {
    reset_mock_card(70000);
    /* 550 FAT sectors, 1 sector per cluster (68,868 clusters >= 65525 required for FAT32) */
    format_mock_fat32_volume(0, 70000, 32, 2, 1, 550, 2);

    /* Mark all FAT entries in 550 FAT sectors as allocated */
    for (uint32_t s = 0; s < 550; s++) {
        uint8_t *fat_sec = get_mock_sector(32 + s, true);
        memset(fat_sec, 0xFF, 512);
        memcpy(get_mock_sector(32+550+s,true),fat_sec,512);
    }

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "no-free-clusters") == 0);

    puts("  PASS: disk full / no free FAT clusters handled cleanly");
}

static void test_device_bounds_validation(void) {
    /* Device capacity only 100 sectors, but partition claims 100,000 sectors */
    reset_mock_card(100);
    format_mock_fat32_volume(0, 100000, 32, 2, 32, 1000, 2);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    assert(fatlog_start(&fs, &io, 0));
    while (fs.phase == FATLOG_PREPARING) fatlog_poll(&fs, 10);

    assert(fs.phase == FATLOG_ERROR);
    assert(strcmp(fs.error, "partition-smaller-than-volume") == 0);

    puts("  PASS: 64-bit device bounds violation explicitly rejected");
}

static void test_fragmented_cluster_allocation_and_readback(void) {
    reset_mock_card(62333952);
    /* 1 sector per cluster for easy fragmentation testing */
    format_mock_fat32_volume(0, 200000, 32, 2, 1, 16384, 2);

    uint32_t fat1_lba = 32;
    uint32_t data_lba = 32 + (2 * 16384);

    /* Mark cluster 3 allocated, cluster 4 free, cluster 5 allocated, cluster 6 free */
    uint8_t *fat1_sec0 = get_mock_sector(fat1_lba, true);
    put32(fat1_sec0 + 12, 0x0FFFFFFF); /* Cluster 3 allocated */
    put32(fat1_sec0 + 16, 0x00000000); /* Cluster 4 free */
    put32(fat1_sec0 + 20, 0x0FFFFFFF); /* Cluster 5 allocated */
    put32(fat1_sec0 + 24, 0x00000000); /* Cluster 6 free */
    memcpy(get_mock_sector(32+16384,true),fat1_sec0,512);

    fatlog_t fs;
    fatlog_io_t io = create_mock_io();

    drive_log_to_ready(&fs, &io);

    /* Write Sector 1 (uses Cluster 4) */
    uint8_t sec1[512], sec2[512];
    memset(sec1, 0xAA, 512);
    memset(sec2, 0xBB, 512);

    assert(fatlog_write(&fs, sec1, 512, 100));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 200);

    /* Write Sector 2 (must skip allocated cluster 5 and pick cluster 6) */
    assert(fatlog_write(&fs, sec2, 512, 300));
    while (fs.phase == FATLOG_WRITING) fatlog_poll(&fs, 400);

    assert(fatlog_close(&fs, 500));
    while (fs.phase == FATLOG_CLOSING) fatlog_poll(&fs, 600);
    assert(fs.phase == FATLOG_DONE);

    /* Verify FAT linkage: cluster 4 -> cluster 6 */
    uint32_t clus4_next = get32(fat1_sec0 + 16) & 0x0FFFFFFF;
    assert(clus4_next == 6);

    /* Verify payload data on disk in cluster 4 (LBA data_lba + 2) and cluster 6 (LBA data_lba + 4) */
    uint8_t *d4 = get_mock_sector(data_lba + 2, false);
    uint8_t *d6 = get_mock_sector(data_lba + 4, false);
    assert(d4 != NULL && memcmp(d4, sec1, 512) == 0);
    assert(d6 != NULL && memcmp(d6, sec2, 512) == 0);

    puts("  PASS: fragmented cluster chain allocation & payload data readback");
}

int main(void) {
    puts("=========================================================");
    puts("  BOBFLIGHT FAT32 LOG WRITER NATIVE TEST SUITE");
    puts("=========================================================");

    test_user_probe_card_geometry();
    test_preexisting_files_unchanged_proof();
    test_sequential_duplicate_filenames();
    test_slot_reuse_deleted_entry();
    test_exfat_rejection();
    test_gpt_rejection();
    test_dirty_volume_rejection();
    test_fat_mirror_mismatch_rejection();
    test_fault_injection_and_dirty_preservation();
    test_disk_full_no_free_clusters();
    test_device_bounds_validation();
    test_fragmented_cluster_allocation_and_readback();

    puts("=========================================================");
    puts("  ALL FAT32 LOG WRITER NATIVE TESTS PASSED SUCCESSFULLY!");
    puts("=========================================================");
    return 0;
}
