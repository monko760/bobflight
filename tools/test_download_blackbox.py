#!/usr/bin/env python3
"""
Unit tests for tools/download_blackbox.py.
Covers FAT32 reader, sparse card fixture, protocol framing, and error conditions.
"""

import sys
import os
import zlib
import struct
import tempfile
import unittest
from typing import Dict, List, Optional

# Add workspace tools directory to import path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.download_blackbox import (
    FAT32Reader,
    FAT32Error,
    DeviceProtocolError,
    parse_sd_read_response,
)


class SparseCardFixture:
    """
    Sparse card fixture simulating a 32GB SD card with exact geometry:
    62,333,952 sectors, 16KiB clusters (32 sec/clus), FAT size 16,384 sectors.
    """

    def __init__(
        self,
        card_sectors: int = 62333952,
        vbr_tot_sec: Optional[int] = None,
        sec_per_clus: int = 32,
        fat_sz32: int = 16384,
        rsvd_sec_cnt: int = 32,
        num_fats: int = 2,
        root_clus: int = 2,
        partition_type: str = "superfloppy",
        file_size: int = 40116,
        filename: str = "BFL00001.BBL",
        file_clusters: Optional[List[int]] = None,
        mirror_mismatch_cluster: Optional[int] = None,
        dirty_clean_bit: bool = True,
        dirty_error_bit: bool = True,
        loop_cluster: Optional[int] = None,
        short_chain: bool = False,
        long_chain: bool = False,
        is_directory: bool = False,
        duplicate_file: bool = False,
        out_of_bounds_data_sec: bool = False,
    ):
        self.card_sectors = card_sectors
        self.sec_per_clus = sec_per_clus
        self.fat_sz32 = fat_sz32
        self.rsvd_sec_cnt = rsvd_sec_cnt
        self.num_fats = num_fats
        self.root_clus = root_clus
        self.sectors: Dict[int, bytearray] = {}

        if file_clusters is None:
            if out_of_bounds_data_sec:
                file_clusters = [3, 4, 99999999]
            else:
                file_clusters = [3, 4, 5]
        self.file_clusters = file_clusters

        if partition_type == "superfloppy":
            self.partition_offset = 0
        elif partition_type == "mbr":
            self.partition_offset = 2048
            mbr = bytearray(512)
            mbr[510:512] = b"\x55\xaa"
            entry_off = 446
            mbr[entry_off + 4] = 0x0C  # FAT32 LBA
            struct.pack_into("<I", mbr, entry_off + 8, self.partition_offset)
            struct.pack_into("<I", mbr, entry_off + 12, self.card_sectors - self.partition_offset)
            self.sectors[0] = mbr
        else:
            raise ValueError(f"Unknown partition type: {partition_type}")

        # VBR (BPB) at partition_offset
        vbr = bytearray(512)
        vbr[0:3] = b"\xeb\x58\x90"
        vbr[3:11] = b"MSWIN4.1"
        struct.pack_into("<H", vbr, 11, 512)  # BPB_BytsPerSec
        vbr[13] = self.sec_per_clus
        struct.pack_into("<H", vbr, 14, self.rsvd_sec_cnt)
        vbr[16] = self.num_fats
        struct.pack_into("<H", vbr, 17, 0)  # BPB_RootEntCnt
        struct.pack_into("<H", vbr, 19, 0)  # BPB_TotSec16
        vbr[21] = 0xF8  # BPB_Media
        struct.pack_into("<H", vbr, 22, 0)  # BPB_FATSz16

        tot_sec_val = vbr_tot_sec if vbr_tot_sec is not None else (self.card_sectors - self.partition_offset)
        struct.pack_into("<I", vbr, 32, tot_sec_val)  # BPB_TotSec32
        struct.pack_into("<I", vbr, 36, self.fat_sz32)
        struct.pack_into("<H", vbr, 40, 0)  # BPB_ExtFlags (mirrored)
        struct.pack_into("<H", vbr, 42, 0)  # BPB_FSVer
        struct.pack_into("<I", vbr, 44, self.root_clus)
        vbr[82:90] = b"FAT32   "
        vbr[510:512] = b"\x55\xaa"
        self.sectors[self.partition_offset] = vbr

        # FAT Tables setup
        self.fat1_start = self.partition_offset + self.rsvd_sec_cnt
        self.fat2_start = self.fat1_start + self.fat_sz32
        self.first_data_sector = self.partition_offset + self.rsvd_sec_cnt + (self.num_fats * self.fat_sz32)

        def set_fat(cluster: int, val: int, fat_num: int = 1):
            byte_off = cluster * 4
            sec_idx = byte_off // 512
            intra_off = byte_off % 512
            fat_start = self.fat1_start if fat_num == 1 else self.fat2_start
            sec_lba = fat_start + sec_idx
            if sec_lba not in self.sectors:
                self.sectors[sec_lba] = bytearray(512)
            struct.pack_into("<I", self.sectors[sec_lba], intra_off, val)

        set_fat(0, 0x0FFFFFF8, 1)
        if self.num_fats == 2:
            set_fat(0, 0x0FFFFFF8, 2)

        clean_bit = 0x08000000 if dirty_clean_bit else 0
        error_bit = 0x04000000 if dirty_error_bit else 0
        entry1_val = 0x0FFFFFFF & (0xF3FFFFFF | clean_bit | error_bit)
        set_fat(1, entry1_val, 1)
        if self.num_fats == 2:
            set_fat(1, entry1_val, 2)

        set_fat(2, 0x0FFFFFFF, 1)
        if self.num_fats == 2:
            set_fat(2, 0x0FFFFFFF, 2)

        if short_chain:
            chain_map = {3: 4, 4: 0x0FFFFFFF}
        elif long_chain:
            chain_map = {3: 4, 4: 5, 5: 6, 6: 0x0FFFFFFF}
        elif loop_cluster is not None:
            chain_map = {3: 4, 4: 5, 5: loop_cluster}
        else:
            chain_map = {}
            for i in range(len(self.file_clusters) - 1):
                chain_map[self.file_clusters[i]] = self.file_clusters[i + 1]
            chain_map[self.file_clusters[-1]] = 0x0FFFFFFF

        for c_src, c_dst in chain_map.items():
            set_fat(c_src, c_dst, 1)
            if self.num_fats == 2:
                fat2_val = c_dst
                if mirror_mismatch_cluster is not None and c_src == mirror_mismatch_cluster:
                    fat2_val = 0x0FFFFFF9
                set_fat(c_src, fat2_val, 2)

        # Root Directory Entry
        root_lba = self.first_data_sector + (self.root_clus - 2) * self.sec_per_clus
        if root_lba not in self.sectors:
            self.sectors[root_lba] = bytearray(512)

        root_sec = self.sectors[root_lba]

        def write_dir_entry(offset: int):
            parts = filename.split(".", 1) if "." in filename else [filename, ""]
            n_bytes = parts[0].upper().ljust(8, " ")[:8].encode("ascii")
            e_bytes = parts[1].upper().ljust(3, " ")[:3].encode("ascii")

            root_sec[offset: offset + 8] = n_bytes
            root_sec[offset + 8: offset + 11] = e_bytes
            root_sec[offset + 11] = 0x10 if is_directory else 0x20
            struct.pack_into("<H", root_sec, offset + 20, (self.file_clusters[0] >> 16) & 0xFFFF)
            struct.pack_into("<H", root_sec, offset + 26, self.file_clusters[0] & 0xFFFF)
            struct.pack_into("<I", root_sec, offset + 28, file_size)

        write_dir_entry(0)
        if duplicate_file:
            write_dir_entry(32)

        # File Data Payload
        self.payload = bytes([(i * 13 + 37) % 256 for i in range(file_size)])
        clus_bytes = self.sec_per_clus * 512

        for idx, clus in enumerate(self.file_clusters):
            if clus >= self.card_sectors // self.sec_per_clus:
                continue
            p_chunk = self.payload[idx * clus_bytes: (idx + 1) * clus_bytes]
            clus_lba = self.first_data_sector + (clus - 2) * self.sec_per_clus

            for s in range(self.sec_per_clus):
                sec_offset = s * 512
                sec_data = p_chunk[sec_offset: sec_offset + 512]
                if not sec_data:
                    sec_data = b"\x00" * 512
                elif len(sec_data) < 512:
                    sec_data = sec_data.ljust(512, b"\x00")

                self.sectors[clus_lba + s] = bytearray(sec_data)

    def read_sector(self, lba: int) -> bytes:
        if lba < 0 or lba >= self.card_sectors:
            raise FAT32Error(f"Sector {lba} out of card bounds (0..{self.card_sectors - 1})")
        if lba in self.sectors:
            return bytes(self.sectors[lba])
        return b"\x00" * 512


class TestBlackboxDownload(unittest.TestCase):

    def test_valid_superfloppy(self):
        card = SparseCardFixture(partition_type="superfloppy")
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        data = reader.read_file("BFL00001.BBL")
        self.assertEqual(len(data), 40116)
        self.assertEqual(data, card.payload)

    def test_valid_mbr(self):
        card = SparseCardFixture(partition_type="mbr")
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        data = reader.read_file("BFL00001.BBL")
        self.assertEqual(len(data), 40116)
        self.assertEqual(data, card.payload)

    def test_fragmented_chain(self):
        card = SparseCardFixture(file_clusters=[3, 10, 7])
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        data = reader.read_file("BFL00001.BBL")
        self.assertEqual(len(data), 40116)
        self.assertEqual(data, card.payload)

    def test_final_partial_sector(self):
        card = SparseCardFixture(file_size=40116)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        data = reader.read_file("BFL00001.BBL")
        self.assertEqual(len(data), 40116)
        self.assertEqual(data, card.payload)

    def test_cross_bounds(self):
        card = SparseCardFixture(out_of_bounds_data_sec=True)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        with self.assertRaises(FAT32Error) as cm:
            reader.read_file("BFL00001.BBL")
        self.assertIn("out of valid cluster range", str(cm.exception).lower())

    def test_capacity_cross_bounds(self):
        card = SparseCardFixture(card_sectors=1000, vbr_tot_sec=62333952)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        with self.assertRaises(FAT32Error) as cm:
            reader.mount()
        self.assertIn("exceed device capacity", str(cm.exception).lower())

    def test_mirror_mismatch(self):
        card = SparseCardFixture(mirror_mismatch_cluster=4)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        with self.assertRaises(FAT32Error) as cm:
            reader.mount()
            reader.read_file("BFL00001.BBL")
        self.assertIn("mirror mismatch", str(cm.exception).lower())

    def test_loops_in_fat_chain(self):
        card = SparseCardFixture(loop_cluster=3)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        with self.assertRaises(FAT32Error) as cm:
            reader.read_file("BFL00001.BBL")
        self.assertIn("cycle", str(cm.exception).lower())

    def test_short_fat_chain(self):
        card = SparseCardFixture(short_chain=True)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        with self.assertRaises(FAT32Error) as cm:
            reader.read_file("BFL00001.BBL")
        self.assertIn("prematurely", str(cm.exception).lower())

    def test_long_fat_chain(self):
        card = SparseCardFixture(long_chain=True)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        reader.mount()
        with self.assertRaises(FAT32Error) as cm:
            reader.read_file("BFL00001.BBL")
        self.assertIn("longer than allocated", str(cm.exception).lower())

    def test_dirty_fat_clean_bit_cleared(self):
        card = SparseCardFixture(dirty_clean_bit=False)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        with self.assertRaises(FAT32Error) as cm:
            reader.mount()
        self.assertIn("dirty", str(cm.exception).lower())

    def test_dirty_fat_error_bit_cleared(self):
        card = SparseCardFixture(dirty_error_bit=False)
        reader = FAT32Reader(card.read_sector, card.card_sectors)
        with self.assertRaises(FAT32Error) as cm:
            reader.mount()
        self.assertIn("hard error", str(cm.exception).lower())

    def test_protocol_parsing_valid(self):
        raw_sector = b"A" * 512
        crc_val = zlib.crc32(raw_sector) & 0xFFFFFFFF
        hex_str = raw_sector.hex()
        lines = [
            "sd_data_api:1",
            "sd_data_sector:100",
            f"sd_data_hex:{hex_str}",
            f"sd_data_crc32:{crc_val:08x}",
            "sd_data_end:1",
        ]
        parsed = parse_sd_read_response(lines, 100)
        self.assertEqual(parsed, raw_sector)

    def test_protocol_parsing_crc_error(self):
        raw_sector = b"B" * 512
        hex_str = raw_sector.hex()
        bad_crc = 0x12345678
        lines = [
            "sd_data_api:1",
            "sd_data_sector:100",
            f"sd_data_hex:{hex_str}",
            f"sd_data_crc32:{bad_crc:08x}",
            "sd_data_end:1",
        ]
        with self.assertRaises(DeviceProtocolError) as cm:
            parse_sd_read_response(lines, 100)
        self.assertIn("checksum mismatch", str(cm.exception).lower())

    def test_protocol_parsing_duplicate_field(self):
        raw_sector = b"C" * 512
        crc_val = zlib.crc32(raw_sector) & 0xFFFFFFFF
        hex_str = raw_sector.hex()
        lines = [
            "sd_data_api:1",
            "sd_data_sector:100",
            f"sd_data_hex:{hex_str}",
            f"sd_data_hex:{hex_str}",
            f"sd_data_crc32:{crc_val:08x}",
            "sd_data_end:1",
        ]
        with self.assertRaises(DeviceProtocolError) as cm:
            parse_sd_read_response(lines, 100)
        self.assertIn("duplicate", str(cm.exception).lower())

    def test_output_file_already_exists_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = os.path.join(tmpdir, "out.bbl")
            with open(out_file, "w") as f:
                f.write("EXISTING_CONTENT")

            cmd = f"{sys.executable} -m tools.download_blackbox --port MOCK --file BFL00001.BBL --output {out_file}"
            ret = os.system(f"{cmd} >/dev/null 2>&1")
            self.assertNotEqual(ret, 0)

            with open(out_file, "r") as f:
                content = f.read()
            self.assertEqual(content, "EXISTING_CONTENT")


if __name__ == "__main__":
    unittest.main()
