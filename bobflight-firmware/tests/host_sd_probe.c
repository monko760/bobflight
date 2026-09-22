/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#define main original_sd_tests_main
#include "host_sd_spi.c"
#undef main
#include "drivers/sd_probe.h"
static void put16(uint8_t *b,uint16_t n){b[0]=(uint8_t)n;b[1]=(uint8_t)(n>>8);}
static void put32(uint8_t *b,uint32_t n){put16(b,(uint16_t)n);put16(b+2,(uint16_t)(n>>16));}
static void boot_exfat(uint8_t *b,uint32_t offset){
 memset(b,0,512);memcpy(b+3,"EXFAT   ",8);b[510]=0x55;b[511]=0xaa;put32(b+64,offset);put32(b+72,100000);put32(b+80,24);put32(b+84,800);put32(b+88,824);put32(b+92,99176);put32(b+96,2);b[108]=9;b[109]=0;b[110]=1;put16(b+106,2);
}
static sd_probe_t probe;
static void run_probe(void){sd_spi_io_t io=create_mock_io();probe=(sd_probe_t){0};assert(sd_probe_start(&probe,&io,0));assert(!sd_probe_start(&probe,&io,0));for(unsigned i=0;i<10000&&sd_probe_busy(&probe);i++)sd_probe_poll(&probe,(uint64_t)i*10);assert(!sd_probe_busy(&probe));assert(!g_mock.receiving_write_data);assert(!g_mock.write_commands);}
int main(void){
 reset_mock_card(MOCK_CARD_SDHC_64GB);boot_exfat(g_mock.memory[0],0);run_probe();assert(probe.phase==SD_PROBE_DONE&&!strcmp(probe.filesystem,"exFAT")&&probe.cluster_bytes==512&&probe.volume_flags==2);
 reset_mock_card(MOCK_CARD_SDHC_64GB);memset(g_mock.memory[0],0,512);g_mock.memory[0][510]=0x55;g_mock.memory[0][511]=0xaa;g_mock.memory[0][450]=7;put32(g_mock.memory[0]+454,1);put32(g_mock.memory[0]+458,100000);boot_exfat(g_mock.memory[1],1);run_probe();assert(probe.phase==SD_PROBE_DONE&&probe.partition_lba==1);
 uint8_t *b=g_mock.memory[1];memset(b,0,512);memcpy(b+82,"FAT32   ",8);b[510]=0x55;b[511]=0xaa;put16(b+11,512);b[13]=1;put16(b+14,32);b[16]=2;put32(b+32,100000);put32(b+36,800);put32(b+44,2);run_probe();assert(probe.phase==SD_PROBE_DONE&&!strcmp(probe.filesystem,"FAT32"));
 put32(b+36,1);run_probe();assert(probe.phase==SD_PROBE_ERROR&&!strcmp(probe.detail,"invalid-or-unsupported-volume-geometry"));
 g_mock.memory[0][450]=0xee;run_probe();assert(probe.phase==SD_PROBE_ERROR&&!strcmp(probe.detail,"GPT-not-yet-supported"));
 g_mock.memory[0][450]=7;put32(g_mock.memory[0]+454,125000704);run_probe();assert(probe.phase==SD_PROBE_ERROR&&!strcmp(probe.detail,"invalid-partition-bounds"));
 reset_mock_card(MOCK_CARD_SDHC_64GB);sd_spi_io_t io=create_mock_io();probe=(sd_probe_t){0};assert(sd_probe_start(&probe,&io,0));sd_probe_cancel(&probe);assert(probe.phase==SD_PROBE_CANCELLED);sd_probe_poll(&probe,99999);assert(probe.phase==SD_PROBE_CANCELLED);
 puts("PASS read-only probe: exFAT, FAT32, MBR, geometry/bounds/GPT refusal, busy/cancel; no write operations requested");
}
