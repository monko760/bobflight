# SPDX-License-Identifier: Apache-2.0
#!/usr/bin/env python3
"""
Stand-alone CLI utility and FAT32 reader for flight recorder blackbox logs.
Strict framing, protocol validation, and FAT32 verification.
"""

import re
import sys
import os
import time
import argparse
import zlib
import struct
import math
from typing import Callable, Optional, Dict, List, Set, Tuple

# Optional serial dependency
try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None


class DeviceProtocolError(Exception):
    """Raised when serial device framing or protocol validation fails."""
    pass


class FAT32Error(Exception):
    """Raised when FAT32 filesystem structures fail validation."""
    pass


class SerialAdapter:
    """Handles communication with the hardware serial port."""

    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 8.0):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.ser = None

    def open(self):
        if serial is None:
            raise RuntimeError("pyserial module is not installed; real serial ports are unavailable.")
        self.ser = serial.Serial(self.port, self.baudrate, timeout=0.1)

    def close(self):
        if self.ser and self.ser.is_open:
            try:
                self.ser.close()
            except Exception:
                pass

    def send_command(self, cmd: str, timeout: float = 8.0, max_bytes: int = 16384) -> List[str]:
        if not self.ser or not self.ser.is_open:
            raise RuntimeError("Serial port is not open.")

        if cmd not in ('sd probe','sd status','sd cancel') and not re.fullmatch(r'sd read (0|[1-9][0-9]{0,9})',cmd):
            raise DeviceProtocolError('Only read-only SD commands are allowed')
        # Clear input buffer
        self.ser.reset_input_buffer()
        self.ser.write((cmd + "\n").encode("utf-8"))
        self.ser.flush()

        lines = []
        received=0
        start_time = time.monotonic()
        buf = bytearray()

        while True:
            if time.monotonic() - start_time > timeout:
                raise DeviceProtocolError(f"Command '{cmd}' timed out after {timeout}s")

            raw = self.ser.read(1024)
            if raw:
                received+=len(raw)
                buf.extend(raw)
                if received > max_bytes:
                    raise DeviceProtocolError(f"Response to '{cmd}' exceeded maximum allowed length ({max_bytes} bytes)")

            # Process completed lines
            while b"\n" in buf:
                idx = buf.index(b"\n")
                line_bytes = buf[:idx]
                buf = buf[idx + 1:]
                line = line_bytes.decode("utf-8", errors="strict").strip("\r\n").strip()
                if line:
                    lines.append(line)
                    # Check terminal line conditions
                    if line in ("sd_end:1", "sd_end: 1", "sd_data_end:1", "sd_data_end: 1"):
                        return lines
            time.sleep(0.01)


def parse_sd_read_response(lines: List[str], expected_lba: int) -> bytes:
    """
    Parses exact response lines from `sd read N` command.
    Strictly checks framing, offset, checksum, length, duplicates, 16KB reply cap.
    """
    if not lines or lines[-1].replace(' ','')!='sd_data_end:1':
        raise DeviceProtocolError('Missing final sd_data_end marker')
    fields: Dict[str, str] = {}
    total_len = sum(len(line) + 2 for line in lines)
    if total_len > 16384:
        raise DeviceProtocolError("sd read response exceeded 16KB cap")

    for line in lines:
        if ":" not in line:
            line_lower = line.lower()
            if any(term in line_lower for term in ("unknown", "unsupported", "refused", "invalid", "error")):
                raise DeviceProtocolError(f"Device rejected command: {line}")
            continue

        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()

        if key in fields:
            raise DeviceProtocolError(f"Duplicate protocol field detected in response: {key}")

        fields[key] = value

    if "sd_data_error" in fields:
        raise DeviceProtocolError(f"SD device returned error: {fields['sd_data_error']}")

    required_keys = ["sd_data_api", "sd_data_sector", "sd_data_hex", "sd_data_crc32", "sd_data_end"]
    for k in required_keys:
        if k not in fields:
            raise DeviceProtocolError(f"Missing required protocol field in sd read response: {k}")

    # Explicit no unknown unsupported FW silent accept
    if fields["sd_data_api"] != "1":
        raise DeviceProtocolError(f"Unsupported sd_data_api version: {fields['sd_data_api']}")

    if fields["sd_data_end"] != "1":
        raise DeviceProtocolError(f"Invalid sd_data_end marker: {fields['sd_data_end']}")

    if not re.fullmatch(r'0|[1-9][0-9]{0,9}',fields['sd_data_sector']):
        raise DeviceProtocolError('Noncanonical sector number')
    try:
        resp_lba = int(fields["sd_data_sector"])
    except ValueError:
        raise DeviceProtocolError(f"Invalid sector number format: {fields['sd_data_sector']}")

    if resp_lba != expected_lba:
        raise DeviceProtocolError(f"Sector LBA mismatch: requested {expected_lba}, got {resp_lba}")

    hex_str = fields["sd_data_hex"]
    if len(hex_str) != 1024:
        raise DeviceProtocolError(f"sd_data_hex length must be 1024 hex chars (got {len(hex_str)})")

    try:
        raw_bytes = bytes.fromhex(hex_str)
    except ValueError:
        raise DeviceProtocolError("sd_data_hex contains invalid hex characters")

    if len(raw_bytes) != 512:
        raise DeviceProtocolError(f"Decoded sector byte length is {len(raw_bytes)} instead of 512")

    crc_str = fields["sd_data_crc32"]
    if not re.fullmatch(r'[0-9A-Fa-f]{8}',crc_str):
        raise DeviceProtocolError(f"sd_data_crc32 must be 8 hex chars (got '{crc_str}')")

    try:
        expected_crc = int(crc_str, 16)
    except ValueError:
        raise DeviceProtocolError(f"Invalid CRC32 hex string: {crc_str}")

    actual_crc = zlib.crc32(raw_bytes) & 0xFFFFFFFF
    if actual_crc != expected_crc:
        raise DeviceProtocolError(f"CRC32 checksum mismatch for sector {expected_lba}: expected 0x{expected_crc:08x}, got 0x{actual_crc:08x}")

    return raw_bytes


def probe_sd_device(adapter: SerialAdapter) -> int:
    """
    Sends `sd probe`, polls `sd status` until sd_state is done (15s cap),
    returns total card sectors from sd_sectors or capacitybytes.
    """
    deadline=time.monotonic()+15
    lines=adapter.send_command('sd probe')
    while True:
        fields={}
        for line in lines:
            if ':' in line:
                k,v=(x.strip() for x in line.split(':',1))
                if k in fields:raise DeviceProtocolError('Duplicate probe field: '+k)
                fields[k]=v
        if fields.get('sd_end')!='1' or fields.get('sd_api')!='1':
            raise DeviceProtocolError('SD probe refused or firmware unsupported: '+'; '.join(lines))
        state=fields.get('sd_state')
        if state=='done':
            value=fields.get('sd_sectors','')
            if not re.fullmatch(r'[1-9][0-9]*',value) or int(value)>4294967295:
                raise DeviceProtocolError('Invalid card capacity')
            if fields.get('sd_io_error')!='0':raise DeviceProtocolError('Card reports an I/O error')
            return int(value)
        if state not in ('initializing','reading-mbr','reading-boot-sector'):
            raise DeviceProtocolError('SD probe did not succeed: '+str(state))
        if time.monotonic()>=deadline:raise DeviceProtocolError('SD probe timeout')
        time.sleep(.1)
        lines=adapter.send_command('sd status',timeout=min(8,max(.1,deadline-time.monotonic())))


class FAT32Reader:
    """
    Decoupled FAT32 reader operating over an abstract read_sector(lba) -> bytes callable.
    """

    def __init__(self, read_sector_fn: Callable[[int], bytes], card_sectors: int):
        self.read_sector_fn = read_sector_fn
        self.card_sectors = card_sectors
        self.fat_cache: Dict[int, bytes] = {}
        self.fat_cache_cap = 4096

        self.partition_limit = card_sectors
        self.partition_offset = 0
        self.bytes_per_sec = 512
        self.sec_per_clus = 0
        self.rsvd_sec_cnt = 0
        self.num_fats = 0
        self.fat_sz32 = 0
        self.root_clus = 0
        self.tot_sec = 0
        self.data_sec = 0
        self.count_of_clusters = 0
        self.fat1_start = 0
        self.fat2_start = 0
        self.first_data_sector = 0

    def _read_sector(self, lba: int) -> bytes:
        if lba < 0 or lba >= self.card_sectors:
            raise FAT32Error(f"Sector {lba} out of device bounds (card capacity: {self.card_sectors} sectors)")
        if lba in self.fat_cache:
            return self.fat_cache[lba]
        sec = self.read_sector_fn(lba)
        if len(sec) != 512:
            raise FAT32Error(f"Sector {lba} read returned {len(sec)} bytes, expected 512")
        if len(self.fat_cache) >= self.fat_cache_cap:
            self.fat_cache.pop(next(iter(self.fat_cache)))
        self.fat_cache[lba] = sec
        return sec

    def mount(self):
        sec0 = self._read_sector(0)
        self.partition_offset = self._detect_partition_offset(sec0)
        vbr = sec0 if self.partition_offset == 0 else self._read_sector(self.partition_offset)
        self._parse_vbr(vbr)
        self._verify_clean_fat()

    def _detect_partition_offset(self, sec0: bytes) -> int:
        # Check if sec0 is superfloppy VBR
        if self._is_valid_fat32_vbr(sec0):
            return 0

        if sec0[510:512]!=b"\x55\xaa":raise FAT32Error('Invalid boot signature')
        entries=[]
        for i in range(4):
            e=sec0[446+i*16:462+i*16]
            if e[4]==0xEE:raise FAT32Error('GPT is not supported')
            if e[4] in (0x0B,0x0C):entries.append(struct.unpack_from('<II',e,8))
        if len(entries)!=1:raise FAT32Error('Exactly one FAT32 MBR partition is required')
        start,count=entries[0]
        if not start or not count or start+count>self.card_sectors:raise FAT32Error('Partition exceeds device bounds')
        self.partition_limit=start+count
        if not self._is_valid_fat32_vbr(self._read_sector(start)):raise FAT32Error('Invalid FAT32 boot sector')
        return start

    def _is_valid_fat32_vbr(self, sec: bytes) -> bool:
        if len(sec) != 512:
            return False
        if sec[510:512] != b"\x55\xaa":
            return False
        bps = struct.unpack_from("<H", sec, 11)[0]
        if bps != 512:
            return False
        spc = sec[13]
        if spc not in (1, 2, 4, 8, 16, 32, 64, 128):
            return False
        rsvd = struct.unpack_from("<H", sec, 14)[0]
        if rsvd == 0:
            return False
        num_fats = sec[16]
        if num_fats not in (1, 2):
            return False
        root_ent = struct.unpack_from("<H", sec, 17)[0]
        if root_ent != 0:
            return False
        fat_sz16 = struct.unpack_from("<H", sec, 22)[0]
        if fat_sz16 != 0:
            return False
        fat_sz32 = struct.unpack_from("<I", sec, 36)[0]
        if fat_sz32 == 0:
            return False
        return True

    def _parse_vbr(self, vbr: bytes):
        bps = struct.unpack_from("<H", vbr, 11)[0]
        if bps != 512:
            raise FAT32Error(f"Invalid sector size {bps}, must be 512 BPB")

        spc = vbr[13]
        if spc == 0 or (spc & (spc - 1)) != 0 or spc > 128:
            raise FAT32Error(f"Invalid sectors per cluster (spc={spc}), must be power of 2 <= 128")
        self.sec_per_clus = spc

        self.rsvd_sec_cnt = struct.unpack_from("<H", vbr, 14)[0]
        if self.rsvd_sec_cnt == 0:
            raise FAT32Error("Reserved sector count must be non-zero")

        self.num_fats = vbr[16]
        if self.num_fats not in (1, 2):
            raise FAT32Error(f"Number of FATs must be 1 or 2, got {self.num_fats}")

        root_ent = struct.unpack_from("<H", vbr, 17)[0]
        if root_ent != 0:
            raise FAT32Error(f"BPB_RootEntCnt must be 0 for FAT32, got {root_ent}")

        tot16 = struct.unpack_from("<H", vbr, 19)[0]
        if tot16 != 0:
            raise FAT32Error("BPB_TotSec16 must be 0 for FAT32")

        fat_sz16 = struct.unpack_from("<H", vbr, 22)[0]
        if fat_sz16 != 0:
            raise FAT32Error("BPB_FATSz16 must be 0 for FAT32")

        self.tot_sec = struct.unpack_from("<I", vbr, 32)[0]
        if self.tot_sec == 0:
            raise FAT32Error("BPB_TotSec32 must be non-zero")

        if self.partition_offset + self.tot_sec > self.card_sectors:
            raise FAT32Error(f"FAT32 volume bounds ({self.partition_offset + self.tot_sec} sectors) exceed device capacity ({self.card_sectors} sectors)")

        self.fat_sz32 = struct.unpack_from("<I", vbr, 36)[0]
        if self.fat_sz32 == 0:
            raise FAT32Error("BPB_FATSz32 must be non-zero")

        ext_flags = struct.unpack_from("<H", vbr, 40)[0]
        if (ext_flags & 0x0080) != 0:
            raise FAT32Error("FAT32 is not in mirrored mode (BPB_ExtFlags active FAT set)")

        fs_ver = struct.unpack_from("<H", vbr, 42)[0]
        if fs_ver != 0:
            raise FAT32Error(f"FSversion must be 0, got {fs_ver}")

        self.root_clus = struct.unpack_from("<I", vbr, 44)[0]
        if self.root_clus < 2:
            raise FAT32Error(f"Invalid root cluster {self.root_clus}")

        self.fat1_start = self.partition_offset + self.rsvd_sec_cnt
        self.fat2_start = self.fat1_start + self.fat_sz32
        self.first_data_sector = self.partition_offset + self.rsvd_sec_cnt + (self.num_fats * self.fat_sz32)

        self.data_sec = self.tot_sec - (self.rsvd_sec_cnt + (self.num_fats * self.fat_sz32))
        if self.data_sec <= 0:
            raise FAT32Error("Invalid data sector count <= 0")

        if self.partition_offset+self.tot_sec>self.partition_limit:raise FAT32Error('Volume exceeds MBR partition')
        self.count_of_clusters = self.data_sec // self.sec_per_clus
        if self.count_of_clusters>0x0FFFFFED or (self.count_of_clusters+2)*4>self.fat_sz32*512:
            raise FAT32Error('FAT capacity or cluster count invalid')
        if not 2<=self.root_clus<self.count_of_clusters+2:raise FAT32Error('Root cluster out of bounds')
        if self.count_of_clusters < 65525:
            raise FAT32Error(f"Cluster count ({self.count_of_clusters}) is less than FAT32 minimum 65525")

    def get_fat_entry(self, cluster: int) -> int:
        if cluster < 2 or cluster >= self.count_of_clusters + 2:
            raise FAT32Error(f"Cluster index {cluster} out of valid range (2..{self.count_of_clusters + 1})")

        byte_offset = cluster * 4
        sec_idx = byte_offset // 512
        intra_sec_offset = byte_offset % 512

        if sec_idx >= self.fat_sz32:
            raise FAT32Error(f"FAT access for cluster {cluster} exceeds FAT size")

        fat1_sec = self._read_sector(self.fat1_start + sec_idx)
        val1 = struct.unpack_from("<I", fat1_sec, intra_sec_offset)[0] & 0x0FFFFFFF

        if self.num_fats == 2:
            fat2_sec = self._read_sector(self.fat2_start + sec_idx)
            val2 = struct.unpack_from("<I", fat2_sec, intra_sec_offset)[0] & 0x0FFFFFFF
            if fat1_sec != fat2_sec:
                raise FAT32Error(f"FAT mirror mismatch for cluster {cluster}: FAT1=0x{val1:08x}, FAT2=0x{val2:08x}")

        return val1

    def _verify_clean_fat(self):
        fat1_sec0 = self._read_sector(self.fat1_start)
        if self.num_fats==2 and fat1_sec0!=self._read_sector(self.fat2_start):raise FAT32Error('FAT mirror mismatch')
        fat1_entry1 = struct.unpack_from("<I", fat1_sec0, 4)[0]

        if (fat1_entry1 & 0x08000000) == 0:
            raise FAT32Error("Dirty FAT volume detected (CleanShutBit is 0)")
        if (fat1_entry1 & 0x04000000) == 0:
            raise FAT32Error("FAT volume hard error detected (HardErrorBit is 0)")

    def _normalize_83_filename(self, filename: str) -> bytes:
        if not re.fullmatch(r'BFL[0-9]{5}\.BBL',filename.upper()):raise FAT32Error('Only BFLxxxxx.BBL root files are accepted')
        filename = filename.strip()
        if "." in filename:
            parts = filename.split(".", 1)
            name, ext = parts[0], parts[1]
        else:
            name, ext = filename, ""

        name = name.upper().ljust(8, " ")[:8]
        ext = ext.upper().ljust(3, " ")[:3]
        return (name + ext).encode("ascii")

    def read_file(self, filename: str) -> bytes:
        target_name_83 = self._normalize_83_filename(filename)

        curr_root = self.root_clus
        visited_root_clusters: Set[int] = set()
        scanned_sectors = 0
        file_entry = None

        while True:
            if curr_root in visited_root_clusters:
                raise FAT32Error("Cycle detected in root directory cluster chain")
            visited_root_clusters.add(curr_root)
            next_root=self.get_fat_entry(curr_root)
            if next_root<0x0ffffff8 and not 2<=next_root<min(self.count_of_clusters+2,0x0ffffff0):
                raise FAT32Error('Invalid root chain link')

            clus_lba = self.first_data_sector + (curr_root - 2) * self.sec_per_clus
            first_byte = 0x00
            for s in range(self.sec_per_clus):
                scanned_sectors += 1
                if scanned_sectors > 4096:
                    raise FAT32Error("Root directory scan exceeded 4096 sectors limit")

                sec_bytes = self._read_sector(clus_lba + s)
                for e in range(16):
                    entry = sec_bytes[e * 32 : (e + 1) * 32]
                    first_byte = entry[0]
                    if first_byte == 0x00:
                        break
                    if first_byte == 0xE5:
                        continue

                    attr = entry[11]
                    if attr == 0x0F:
                        continue
                    if attr & 0x08:
                        continue

                    short_name = entry[0:11]
                    if short_name == target_name_83:
                        if attr & 0x10:
                            raise FAT32Error(f"Requested target '{filename}' is a subdirectory")

                        if file_entry is not None:
                            raise FAT32Error(f"Duplicate filename '{filename}' found in root directory")

                        fst_hi = struct.unpack_from("<H", entry, 20)[0]
                        fst_lo = struct.unpack_from("<H", entry, 26)[0]
                        fst_clus = (fst_hi << 16) | fst_lo
                        file_size = struct.unpack_from("<I", entry, 28)[0]
                        file_entry = (fst_clus, file_size)

                if first_byte == 0x00:
                    break

            if first_byte == 0x00:
                break

            next_root = self.get_fat_entry(curr_root)
            if next_root >= 0x0FFFFFF8:
                break
            curr_root = next_root

        if file_entry is None:
            raise FileNotFoundError(f"File '{filename}' not found in root directory")

        fst_clus, file_size = file_entry

        if file_size == 0:
            raise FAT32Error(f"File '{filename}' is empty (0 bytes)")

        if file_size > 64 * 1024 * 1024:
            raise FAT32Error(f"File size ({file_size} bytes) exceeds maximum 64 MiB limit")

        bytes_per_clus = self.sec_per_clus * 512
        expected_clusters = math.ceil(file_size / bytes_per_clus)

        curr_clus = fst_clus
        cluster_chain: List[int] = []
        visited_clusters: Set[int] = set()

        while True:
            if curr_clus < 2 or curr_clus >= self.count_of_clusters + 2:
                raise FAT32Error(f"Cluster {curr_clus} out of valid cluster range")

            if curr_clus in visited_clusters:
                raise FAT32Error(f"Cycle detected in file cluster chain at cluster {curr_clus}")

            if curr_clus in visited_root_clusters:raise FAT32Error('File overlaps root directory')
            if curr_clus >= 0x0FFFFFF0:
                raise FAT32Error(f"Bad cluster link encountered at cluster {curr_clus}")

            visited_clusters.add(curr_clus)
            cluster_chain.append(curr_clus)

            if len(cluster_chain) > expected_clusters:
                raise FAT32Error(f"File cluster chain longer than allocated size ({len(cluster_chain)} > {expected_clusters})")

            next_clus = self.get_fat_entry(curr_clus)
            if next_clus >= 0x0FFFFFF8:
                if len(cluster_chain) < expected_clusters:
                    raise FAT32Error(f"File cluster chain ended prematurely ({len(cluster_chain)} clusters, expected {expected_clusters})")
                break
            curr_clus = next_clus

        buf = bytearray()
        for clus in cluster_chain:
            c_lba = self.first_data_sector + (clus - 2) * self.sec_per_clus
            for s in range(self.sec_per_clus):
                if len(buf)>=file_size:break
                sec_lba = c_lba + s
                if sec_lba >= self.partition_offset + self.tot_sec:
                    raise FAT32Error(f"Data sector {sec_lba} out of volume bounds")
                sec_data = self._read_sector(sec_lba)
                buf.extend(sec_data)

        final_file_data = bytes(buf[:file_size])
        if len(final_file_data) != file_size:
            raise FAT32Error("Read data length does not match expected file size")

        return final_file_data


def save_exclusive(path,data):
    created=False
    try:
        with open(path,'xb') as f:
            created=True
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        if created:os.unlink(path)
        raise

def main():
    parser = argparse.ArgumentParser(description="Flight Recorder Blackbox Download Utility")
    parser.add_argument("--port", help="Serial port (e.g., COM4 or /dev/ttyUSB0)")
    parser.add_argument("--file", help="Filename on SD card (e.g., BFL00001.BBL)")
    parser.add_argument("--output", help="Output destination file path")
    parser.add_argument("--list-ports", action="store_true", help="List available serial ports")

    args = parser.parse_args()

    if args.list_ports:
        if serial is None or not hasattr(serial, "tools"):
            print("pyserial is not installed or list_ports unavailable.")
            sys.exit(1)
        ports = serial.tools.list_ports.comports()
        for p in ports:
            print(f"{p.device} - {p.description}")
        sys.exit(0)

    if not args.port or not args.file or not args.output:
        parser.error("--port, --file, and --output are required unless --list-ports is specified.")

    if os.path.exists(args.output):
        print(f"Error: Output file already exists at '{args.output}'", file=sys.stderr)
        sys.exit(1)

    adapter = SerialAdapter(args.port, baudrate=115200)
    try:
        adapter.open()
        card_sectors = probe_sd_device(adapter)

        def read_sector_fn(lba: int) -> bytes:
            lines = adapter.send_command(f"sd read {lba}")
            return parse_sd_read_response(lines, lba)

        reader = FAT32Reader(read_sector_fn, card_sectors)
        reader.mount()
        file_data = reader.read_file(args.file)

        adapter.send_command('sd cancel')
        save_exclusive(args.output,file_data)

        print(f"Successfully downloaded {len(file_data)} bytes to '{args.output}'")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        try:
            adapter.send_command("sd cancel")
        except Exception:
            pass
        sys.exit(1)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
