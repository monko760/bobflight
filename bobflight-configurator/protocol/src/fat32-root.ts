/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read-only FAT32 root-directory reader for onboard Blackbox logs
 * (`BFLxxxxx.BBL` in the card root). TypeScript port of Robert Leclercq's own
 * FAT32Reader in tools/download_blackbox.py (Apache-2.0, same project), made
 * asynchronous over an abstract `readSector(lba)`.
 *
 * Validates device/partition/volume bounds, BPB fields, FAT capacity and
 * cluster count, clean-shutdown and hard-error flags, mirrored FAT sectors,
 * root and file chain cycles/links/lengths. It never writes, repairs or
 * browses subdirectories. GPT and exFAT are refused.
 */

export class Fat32Error extends Error {
  constructor(message: string) { super(message); this.name = "Fat32Error"; }
}

export interface Fat32BblEntry {
  /** 8.3 name as stored, e.g. `BFL00001.BBL`. */
  name: string;
  /** Directory entry file size in bytes. */
  size: number;
  firstCluster: number;
}

/** Largest file the reader accepts (matches tools/download_blackbox.py). */
export const FAT32_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Root directory scan cap in sectors. */
export const FAT32_ROOT_SCAN_SECTORS = 4096;
const META_CACHE_CAP = 4096;
const EOC = 0x0ffffff8;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Fat32RootReader {
  private cache = new Map<number, Uint8Array>();
  private partitionLimit: number;
  partitionOffset = 0;
  secPerClus = 0;
  rsvdSecCnt = 0;
  numFats = 0;
  fatSz32 = 0;
  rootClus = 0;
  totSec = 0;
  countOfClusters = 0;
  fat1Start = 0;
  fat2Start = 0;
  firstDataSector = 0;
  private rootClusters = new Set<number>();
  private mounted = false;
  private listed = false;

  constructor(
    private readonly readSectorFn: (lba: number) => Promise<Uint8Array>,
    readonly cardSectors: number,
  ) {
    this.partitionLimit = cardSectors;
  }

  /** Bounds-checked metadata read (boot sectors, FAT, root), cached. */
  private async meta(lba: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(lba) || lba < 0 || lba >= this.cardSectors) {
      throw new Fat32Error(`Sector ${lba} out of device bounds (card capacity: ${this.cardSectors} sectors)`);
    }
    const hit = this.cache.get(lba);
    if (hit) return hit;
    const sec = await this.readSectorFn(lba);
    if (sec.length !== 512) throw new Fat32Error(`Sector ${lba} read returned ${sec.length} bytes, expected 512`);
    if (this.cache.size >= META_CACHE_CAP) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(lba, sec);
    return sec;
  }

  async mount(): Promise<void> {
    const sec0 = await this.meta(0);
    this.partitionOffset = await this.detectPartitionOffset(sec0);
    const vbr = this.partitionOffset === 0 ? sec0 : await this.meta(this.partitionOffset);
    this.parseVbr(vbr);
    await this.verifyCleanFat();
    this.mounted = true;
  }

  private async detectPartitionOffset(sec0: Uint8Array): Promise<number> {
    if (Fat32RootReader.isFat32Vbr(sec0)) return 0;
    if (sec0[510] !== 0x55 || sec0[511] !== 0xaa) throw new Fat32Error("Invalid boot signature");
    const entries: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      const o = 446 + i * 16;
      const type = sec0[o + 4];
      if (type === 0xee) throw new Fat32Error("GPT is not supported");
      if (type === 0x0b || type === 0x0c) entries.push([u32(sec0, o + 8), u32(sec0, o + 12)]);
    }
    if (entries.length !== 1) throw new Fat32Error("Exactly one FAT32 MBR partition is required");
    const [start, count] = entries[0];
    if (!start || !count || start + count > this.cardSectors) throw new Fat32Error("Partition exceeds device bounds");
    this.partitionLimit = start + count;
    if (!Fat32RootReader.isFat32Vbr(await this.meta(start))) throw new Fat32Error("Invalid FAT32 boot sector");
    return start;
  }

  static isFat32Vbr(sec: Uint8Array): boolean {
    if (sec.length !== 512 || sec[510] !== 0x55 || sec[511] !== 0xaa) return false;
    if (u16(sec, 11) !== 512) return false;
    if (![1, 2, 4, 8, 16, 32, 64, 128].includes(sec[13])) return false;
    if (u16(sec, 14) === 0) return false;
    if (sec[16] !== 1 && sec[16] !== 2) return false;
    if (u16(sec, 17) !== 0) return false;
    if (u16(sec, 22) !== 0) return false;
    if (u32(sec, 36) === 0) return false;
    return true;
  }

  private parseVbr(vbr: Uint8Array): void {
    if (u16(vbr, 11) !== 512) throw new Fat32Error(`Invalid sector size ${u16(vbr, 11)}, must be 512 BPB`);
    const spc = vbr[13];
    if (spc === 0 || (spc & (spc - 1)) !== 0 || spc > 128) throw new Fat32Error(`Invalid sectors per cluster (spc=${spc}), must be power of 2 <= 128`);
    this.secPerClus = spc;
    this.rsvdSecCnt = u16(vbr, 14);
    if (this.rsvdSecCnt === 0) throw new Fat32Error("Reserved sector count must be non-zero");
    this.numFats = vbr[16];
    if (this.numFats !== 1 && this.numFats !== 2) throw new Fat32Error(`Number of FATs must be 1 or 2, got ${this.numFats}`);
    if (u16(vbr, 17) !== 0) throw new Fat32Error(`BPB_RootEntCnt must be 0 for FAT32, got ${u16(vbr, 17)}`);
    if (u16(vbr, 19) !== 0) throw new Fat32Error("BPB_TotSec16 must be 0 for FAT32");
    if (u16(vbr, 22) !== 0) throw new Fat32Error("BPB_FATSz16 must be 0 for FAT32");
    this.totSec = u32(vbr, 32);
    if (this.totSec === 0) throw new Fat32Error("BPB_TotSec32 must be non-zero");
    if (this.partitionOffset + this.totSec > this.cardSectors) {
      throw new Fat32Error(`FAT32 volume bounds (${this.partitionOffset + this.totSec} sectors) exceed device capacity (${this.cardSectors} sectors)`);
    }
    this.fatSz32 = u32(vbr, 36);
    if (this.fatSz32 === 0) throw new Fat32Error("BPB_FATSz32 must be non-zero");
    if ((u16(vbr, 40) & 0x0080) !== 0) throw new Fat32Error("FAT32 is not in mirrored mode (BPB_ExtFlags active FAT set)");
    if (u16(vbr, 42) !== 0) throw new Fat32Error(`FSversion must be 0, got ${u16(vbr, 42)}`);
    this.rootClus = u32(vbr, 44);
    if (this.rootClus < 2) throw new Fat32Error(`Invalid root cluster ${this.rootClus}`);
    this.fat1Start = this.partitionOffset + this.rsvdSecCnt;
    this.fat2Start = this.fat1Start + this.fatSz32;
    this.firstDataSector = this.partitionOffset + this.rsvdSecCnt + this.numFats * this.fatSz32;
    const dataSec = this.totSec - (this.rsvdSecCnt + this.numFats * this.fatSz32);
    if (dataSec <= 0) throw new Fat32Error("Invalid data sector count <= 0");
    if (this.partitionOffset + this.totSec > this.partitionLimit) throw new Fat32Error("Volume exceeds MBR partition");
    this.countOfClusters = Math.floor(dataSec / this.secPerClus);
    if (this.countOfClusters > 0x0fffffed || (this.countOfClusters + 2) * 4 > this.fatSz32 * 512) throw new Fat32Error("FAT capacity or cluster count invalid");
    if (!(this.rootClus >= 2 && this.rootClus < this.countOfClusters + 2)) throw new Fat32Error("Root cluster out of bounds");
    if (this.countOfClusters < 65525) throw new Fat32Error(`Cluster count (${this.countOfClusters}) is less than FAT32 minimum 65525`);
  }

  async fatEntry(cluster: number): Promise<number> {
    if (cluster < 2 || cluster >= this.countOfClusters + 2) {
      throw new Fat32Error(`Cluster index ${cluster} out of valid range (2..${this.countOfClusters + 1})`);
    }
    const byteOffset = cluster * 4;
    const secIdx = Math.floor(byteOffset / 512);
    const intra = byteOffset % 512;
    if (secIdx >= this.fatSz32) throw new Fat32Error(`FAT access for cluster ${cluster} exceeds FAT size`);
    const fat1 = await this.meta(this.fat1Start + secIdx);
    const val1 = u32(fat1, intra) & 0x0fffffff;
    if (this.numFats === 2) {
      const fat2 = await this.meta(this.fat2Start + secIdx);
      if (!same(fat1, fat2)) {
        const val2 = u32(fat2, intra) & 0x0fffffff;
        throw new Fat32Error(`FAT mirror mismatch for cluster ${cluster}: FAT1=0x${val1.toString(16).padStart(8, "0")}, FAT2=0x${val2.toString(16).padStart(8, "0")}`);
      }
    }
    return val1;
  }

  private async verifyCleanFat(): Promise<void> {
    const fat1 = await this.meta(this.fat1Start);
    if (this.numFats === 2 && !same(fat1, await this.meta(this.fat2Start))) throw new Fat32Error("FAT mirror mismatch");
    const entry1 = u32(fat1, 4);
    if ((entry1 & 0x08000000) === 0) throw new Fat32Error("Dirty FAT volume detected (CleanShutBit is 0)");
    if ((entry1 & 0x04000000) === 0) throw new Fat32Error("FAT volume hard error detected (HardErrorBit is 0)");
  }

  private clusterLba(cluster: number): number {
    return this.firstDataSector + (cluster - 2) * this.secPerClus;
  }

  /** Scan the root directory chain for `BFLxxxxx.BBL` files (subdirectories and other names are skipped). */
  async listBblFiles(): Promise<Fat32BblEntry[]> {
    if (!this.mounted) throw new Fat32Error("FAT32 volume is not mounted");
    const found = new Map<string, Fat32BblEntry>();
    const visited = new Set<number>();
    let cur = this.rootClus;
    let scanned = 0;
    let end = false;
    for (;;) {
      if (visited.has(cur)) throw new Fat32Error("Cycle detected in root directory cluster chain");
      visited.add(cur);
      const next = await this.fatEntry(cur);
      if (next < EOC && !(next >= 2 && next < Math.min(this.countOfClusters + 2, 0x0ffffff0))) throw new Fat32Error("Invalid root chain link");
      const lba = this.clusterLba(cur);
      for (let s = 0; s < this.secPerClus && !end; s++) {
        if (++scanned > FAT32_ROOT_SCAN_SECTORS) throw new Fat32Error(`Root directory scan exceeded ${FAT32_ROOT_SCAN_SECTORS} sectors limit`);
        const sec = await this.meta(lba + s);
        for (let e = 0; e < 16; e++) {
          const o = e * 32;
          const first = sec[o];
          if (first === 0x00) { end = true; break; }
          if (first === 0xe5) continue;
          const attr = sec[o + 11];
          if (attr === 0x0f || attr & 0x08 || attr & 0x10) continue;
          let short = "";
          for (let i = 0; i < 11; i++) short += String.fromCharCode(sec[o + i]);
          if (!/^BFL[0-9]{5}BBL$/.test(short)) continue;
          const name = `${short.slice(0, 8)}.${short.slice(8)}`;
          if (found.has(name)) throw new Fat32Error(`Duplicate filename '${name}' found in root directory`);
          found.set(name, { name, firstCluster: ((u16(sec, o + 20) << 16) | u16(sec, o + 26)) >>> 0, size: u32(sec, o + 28) });
        }
      }
      if (end || next >= EOC) break;
      cur = next;
    }
    this.rootClusters = visited;
    this.listed = true;
    return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Validate the file's whole cluster chain (bounds, cycles, root overlap,
   * exact length for the directory size) and return the LBAs of the
   * ceil(size / 512) sectors that hold the file bytes, in file order.
   */
  async fileDataSectors(entry: Fat32BblEntry): Promise<number[]> {
    if (!this.listed) throw new Fat32Error("Root directory has not been scanned");
    const { name, size } = entry;
    if (size === 0) throw new Fat32Error(`File '${name}' is empty (0 bytes)`);
    if (size > FAT32_MAX_FILE_BYTES) throw new Fat32Error(`File size (${size} bytes) exceeds maximum 64 MiB limit`);
    const clusterBytes = this.secPerClus * 512;
    const expected = Math.ceil(size / clusterBytes);
    const chain: number[] = [];
    const visited = new Set<number>();
    let cur = entry.firstCluster;
    for (;;) {
      if (cur < 2 || cur >= this.countOfClusters + 2) throw new Fat32Error(`Cluster ${cur} out of valid cluster range`);
      if (visited.has(cur)) throw new Fat32Error(`Cycle detected in file cluster chain at cluster ${cur}`);
      if (this.rootClusters.has(cur)) throw new Fat32Error("File overlaps root directory");
      visited.add(cur);
      chain.push(cur);
      if (chain.length > expected) throw new Fat32Error(`File cluster chain longer than allocated size (${chain.length} > ${expected})`);
      const next = await this.fatEntry(cur);
      if (next >= EOC) {
        if (chain.length < expected) throw new Fat32Error(`File cluster chain ended prematurely (${chain.length} clusters, expected ${expected})`);
        break;
      }
      cur = next;
    }
    const sectors: number[] = [];
    const total = Math.ceil(size / 512);
    const volumeEnd = this.partitionOffset + this.totSec;
    for (const c of chain) {
      const base = this.clusterLba(c);
      for (let s = 0; s < this.secPerClus && sectors.length < total; s++) {
        if (base + s >= volumeEnd) throw new Fat32Error(`Data sector ${base + s} out of volume bounds`);
        sectors.push(base + s);
      }
    }
    if (sectors.length !== total) throw new Fat32Error("File sectors do not cover the directory size");
    return sectors;
  }
}
