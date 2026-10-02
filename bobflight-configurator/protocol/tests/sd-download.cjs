/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Onboard SD download, protocol layer: CRC-32, `sd read` reply parser, SD status
 * parser, SdSectorReader (holds the real UI CommandGate, one read in flight,
 * async reply matched by sector, 8 s / 16 KiB limits), the FAT32 root reader
 * (port of tools/download_blackbox.py) and the FW-faithful SD mock.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const P = require('../dist');
const { SparseFat32Card, MockSdCliFirmware, SdSimTransportFactory } = require('../dist/sd-read-mock');
const { loadUiTs } = require('./load-ui-ts.cjs');
const { CommandGate } = loadUiTs(path.join(__dirname, '../../ui/src/protocol/commandGate.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexOf = (b) => Buffer.from(b).toString('hex').toUpperCase();
const reply = (sector, bytes, crc) => `sd_data_api: 1\r\nsd_data_sector: ${sector}\r\nsd_data_hex: ${hexOf(bytes)}\r\nsd_data_crc32: ${crc ?? P.formatCrc32(P.crc32Ieee(bytes))}\r\nsd_data_end: 1\r\n`;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

async function rig(fwOpts = {}, timeoutMs) {
  const fw = new MockSdCliFirmware(fwOpts);
  const factory = new SdSimTransportFactory(fw);
  const client = new P.BobFlightCliClient(factory);
  await client.connect({ path: 'sim://bobflight-sd', transport: 'serial' });
  await sleep(5);
  let generation = 0; client.onStatus(() => generation++);
  const gate = new CommandGate(() => generation);
  const wire = { current: 0, max: 0, cmds: [] };
  const send = async (cmd, opts) => {
    wire.cmds.push({ cmd, opts }); wire.current++; wire.max = Math.max(wire.max, wire.current);
    try { return await client.sendCommand(cmd, opts); } finally { wire.current--; }
  };
  const reader = new P.SdSectorReader(gate, send, timeoutMs);
  const sd = (cmd) => gate.run(() => client.sendCommand(cmd));
  return { fw, factory, client, gate, reader, wire, sd };
}
async function probeDone(r) {
  await r.sd('sd probe');
  for (let i = 0; i < 100; i++) { const s = P.parseSdStatusReply(await r.sd('sd status')); if (s.kind === 'status' && s.state === 'done') return s; await sleep(5); }
  throw new Error('probe never finished');
}

(async () => {
  await test('IEEE CRC-32 matches the FW/zlib definition', () => {
    assert.equal(P.formatCrc32(P.crc32Ieee(Buffer.from('123456789'))), 'CBF43926');
    assert.equal(P.formatCrc32(P.crc32Ieee(new Uint8Array(512))), 'B2AA7578');
    const rnd = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 255);
    if (typeof zlib.crc32 === 'function') assert.equal(P.crc32Ieee(rnd), zlib.crc32(Buffer.from(rnd)) >>> 0);
    assert.equal(P.formatCrc32(0x1a), '0000001A');
  });

  await test('sd read command: canonical decimal 0..2^32-1, never anything else', () => {
    assert.equal(P.formatSdReadCommand(0), 'sd read 0');
    assert.equal(P.formatSdReadCommand(62333951), 'sd read 62333951');
    assert.equal(P.formatSdReadCommand(4294967295), 'sd read 4294967295');
    for (const bad of [-1, 1.5, 4294967296, NaN, Infinity]) assert.throws(() => P.formatSdReadCommand(bad), /invalid SD sector/);
    assert.equal(P.SD_READ_TIMEOUT_MS, 8000); assert.equal(P.SD_READ_REPLY_CAP, 16384); assert.equal(P.SD_PROBE_TIMEOUT_MS, 15000);
  });

  await test('sd read reply parser: data, CRC mismatch, verbatim errors/refusals, strict framing', () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 7) & 255);
    const ok = P.parseSdReadReply(reply(42, bytes), 42);
    assert.equal(ok.kind, 'data'); assert.deepEqual(Buffer.from(ok.bytes), Buffer.from(bytes));
    const bad = P.parseSdReadReply(reply(42, bytes, '00000000'), 42);
    assert.equal(bad.kind, 'crc-mismatch'); assert.equal(bad.sentCrc, '00000000'); assert.equal(bad.actualCrc, P.formatCrc32(P.crc32Ieee(bytes)));
    for (const t of [...P.SD_DATA_ERROR_TEXTS, 'flux capacitor desynchronised (future)']) {
      const r = P.parseSdReadReply(`sd_data_error: ${t}\r\nsd_data_end: 1\r\n`, 9);
      assert.deepEqual(r, { kind: 'error', sector: 9, line: `sd_data_error: ${t}` });
    }
    assert.deepEqual(P.parseSdReadReply('unknown — try help\r\n', 1), { kind: 'refused', sector: 1, line: 'unknown — try help' });
    const malformed = (text, re) => { const r = P.parseSdReadReply(text, 42); assert.equal(r.kind, 'malformed', text.slice(0, 60)); assert.match(r.reason, re); };
    malformed(reply(43, bytes), /reply is for sector 43, expected 42/);
    malformed(reply(42, bytes).replace(/sd_data_hex: ([0-9A-F]+)/, (_, h) => `sd_data_hex: ${h.toLowerCase()}`), /1024 uppercase hex/);
    malformed(reply(42, bytes).replace(/sd_data_hex: ([0-9A-F]+)/, (_, h) => `sd_data_hex: ${h.slice(2)}`), /1024 uppercase hex/);
    malformed(reply(42, bytes).replace(/sd_data_crc32: ([0-9A-F]+)/, (_, c) => `sd_data_crc32: ${c.toLowerCase()}a`), /8 uppercase hex/);
    malformed(reply(42, bytes).replace('sd_data_api: 1', 'sd_data_api: 2'), /sd_data_api: 2/);
    malformed(reply(42, bytes).replace('sd_data_sector: 42', 'sd_data_sector: 042'), /non-canonical/);
    malformed(reply(42, bytes) + 'sd_data_end: 1\r\n', /duplicate sd_data_end/);
    malformed(reply(42, bytes).replace('sd_data_end: 1\r\n', ''), /sd_data_end/);
    malformed('BobFlight 0.1.0 ready\r\n' + reply(42, bytes), /unexpected line/);
    malformed(reply(42, bytes).replace('sd_data_end', 'sd_data_extra: 1\r\nsd_data_end'), /unexpected sd_data_extra/);
    malformed('x'.repeat(16385), /16384/);
  });

  await test('SD status parser: refusals verbatim, done needs sd_sectors and sd_io_error 0', () => {
    // Matched on the `sd refused:` / `sd unavailable:` prefix only: any tail (today's or a future FW's) is kept verbatim.
    for (const line of [...P.SD_PROBE_REFUSALS, 'sd unavailable: no hardware backend in host simulation', 'sd refused: read in progress',
      'sd refused: a future FW 9 reason (code 41)', 'sd unavailable: card removed while idle', 'sd unavailable:']) {
      const r = P.parseSdStatusReply(`${line}\r\nsd_end: 1\r\n`);
      assert.equal(r.kind, 'refused', line);
      assert.equal(r.line, line);
      const rr = P.parseSdReadReply(`${line}\r\nsd_end: 1\r\n`, 7);
      assert.equal(rr.kind, 'refused', `sd read: ${line}`);
      assert.equal(rr.line, line);
    }
    const st = (over = '') => `sd_api: 1\r\nsd_state: done\r\nsd_detail: geometry-recognized-not-mounted\r\nsd_sectors: 62333952\r\nsd_io_error: 0\r\n${over}sd_end: 1\r\n`;
    const s = P.parseSdStatusReply(st());
    assert.equal(s.kind, 'status'); assert.deepEqual(P.sdReadyCapacity(s), { ok: true, sectors: 62333952 });
    assert.match(P.sdReadyCapacity(P.parseSdStatusReply(st().replace('sd_sectors: 62333952\r\n', ''))).reason, /sd_sectors missing/);
    assert.match(P.sdReadyCapacity(P.parseSdStatusReply(st().replace('sd_io_error: 0', 'sd_io_error: 3'))).reason, /sd_io_error: 3/);
    assert.match(P.sdReadyCapacity(P.parseSdStatusReply(st().replace('done', 'initializing'))).reason, /sd_state: initializing/);
    assert.equal(P.parseSdStatusReply(st('sd_state: done\r\n')).kind, 'malformed');
    assert.equal(P.parseSdStatusReply('sd_state: done\r\n').kind, 'malformed');
    assert.deepEqual(P.sdReadyCapacity(P.parseSdStatusReply(st().replace('62333952', '8589934592'))), { ok: true, sectors: 4294967296 });
  });

  await test('SdSectorReader holds the real CommandGate until sd_data_end for that sector arrives on a later poll', async () => {
    const r = await rig({ readDelayMs: 40 });
    await probeDone(r);
    const pending = r.reader.read(0);
    await sleep(15);
    assert.equal(r.fw.readInFlight, true, 'FW began the read and printed nothing inline');
    assert.equal(r.reader.busy, true);
    await assert.rejects(() => r.gate.run(async () => 'status'), /request not queued/, 'no other command can interleave');
    await assert.rejects(() => r.reader.read(1), /already in flight/, 'a second read is refused, never pipelined');
    const got = await pending;
    assert.equal(got.kind, 'data');
    assert.deepEqual(Buffer.from(got.bytes), Buffer.from(r.fw.card.readSector(0)));
    assert.deepEqual(r.wire.cmds.map((c) => c.cmd), ['sd read 0']);
    assert.deepEqual(r.wire.cmds[0].opts, { timeoutMs: 8000, maxResponseChars: 16384 });
    assert.equal(r.fw.readsWhileActive, 0);
    for (let s = 1; s <= 5; s++) assert.equal((await r.reader.read(s)).kind, 'data');
    assert.equal(r.wire.max, 1, 'exactly one sd read in flight');
    assert.deepEqual(r.fw.readsStarted, [0, 1, 2, 3, 4, 5]);
    await r.client.disconnect();
  });

  await test('SdSectorReader: every FW error line verbatim (immediate and mid-read async), unknown future too', async () => {
    const r = await rig();
    for (const t of [...P.SD_DATA_ERROR_TEXTS, 'some future error']) {
      await probeDone(r);
      const line = `sd_data_error: ${t}`;
      r.fw.addFault(7, { type: /guard check failed|driver error/.test(t) ? 'async' : 'immediate', line });
      assert.deepEqual(await r.reader.read(7), { kind: 'error', sector: 7, line });
    }
    await r.client.disconnect();
  });

  await test('SdSectorReader: wrong-sector reply is never accepted; CRC corruption is reported for a retry', async () => {
    const r = await rig();
    await probeDone(r);
    r.fw.addFault(5, { type: 'wrong-sector', sector: 6 });
    const w = await r.reader.read(5);
    assert.equal(w.kind, 'malformed'); assert.match(w.reason, /reply is for sector 6, expected 5/);
    r.fw.addFault(5, { type: 'crc' });
    assert.equal((await r.reader.read(5)).kind, 'crc-mismatch');
    assert.equal((await r.reader.read(5)).kind, 'data');
    await r.client.disconnect();
  });

  await test('SdSectorReader: timeout result, 16 KiB cap, gate busy never sends', async () => {
    const r = await rig({}, 120);
    await probeDone(r);
    r.fw.addFault(3, { type: 'silent' });
    assert.deepEqual(await r.reader.read(3), { kind: 'timeout', sector: 3, timeoutMs: 120 });
    await sleep(20);
    assert.equal(r.client.getConnectionStatus(), 'disconnected', 'existing client policy: a framed reply that never terminates drops the link');
    const capped = new P.SdSectorReader({ run: (w) => w() }, async () => { throw new Error('CLI response exceeds 16384-character limit'); });
    assert.match((await capped.read(1)).reason, /16384/);
    let sent = 0;
    const busy = new P.SdSectorReader({ run: async () => { throw new Error('another UI command is in flight; request not queued'); } }, async () => { sent++; return ''; });
    await assert.rejects(() => busy.read(1), (e) => e instanceof P.SdGateBusyError);
    assert.equal(sent, 0);
    const c = new P.ResponseCollector(() => assert.fail('accepted oversized reply'), (e) => { assert.match(e.message, /16384-character/); }, { endMarker: 'sd_data_end: 1', maxChars: 16384 });
    c.push('x'.repeat(16385));
    const cAsync = await rig({}, 8000);
    await probeDone(cAsync);
    const raw = await cAsync.client.sendCommand('sd read 0', { timeoutMs: 8000, maxResponseChars: 16384 });
    assert.equal(P.parseSdReadReply(raw, 0).kind, 'data', 'the client waits for sd_data_end across 64-byte chunks');
    await cAsync.client.disconnect();
  });

  await test('FW mock: stale probe from before a recording reads `driver error` until a fresh probe; pipelining is detected', async () => {
    const r = await rig({ initialPhase: 'done', stale: true });
    assert.equal(P.parseSdStatusReply(await r.sd('sd status')).state, 'done', 'stale probe still says done');
    assert.deepEqual(await r.reader.read(0), { kind: 'error', sector: 0, line: 'sd_data_error: driver error' });
    await probeDone(r);
    assert.equal((await r.reader.read(0)).kind, 'data');
    r.fw.recordingCycle();
    assert.equal((await r.reader.read(0)).line, 'sd_data_error: driver error');
    await probeDone(r);
    r.fw.readDelayMs = 30;
    const out = [];
    r.fw.handle('sd read 1', (t) => out.push(t));
    r.fw.handle('sd read 2', (t) => out.push(t));
    assert.equal(r.fw.readsWhileActive, 1);
    assert.match(out.join(''), /sd_data_error: read in progress/);
    await sleep(50);
    await r.client.disconnect();
  });

  await test('FAT32 root reader: lists BFL*.BBL with sizes, multi-cluster and fragmented chains, MBR', async () => {
    for (const partition of ['superfloppy', 'mbr']) {
      const card = new SparseFat32Card({ partition, files: [
        { name: 'BFL00001.BBL', size: 40116, clusters: [3, 4, 5] },
        { name: 'BFL00002.BBL', size: 700, clusters: [6] },
        { name: 'BFL00003.BBL', size: 20000, clusters: [10, 7] },
      ] });
      const reads = [];
      const fs = new P.Fat32RootReader(async (lba) => { reads.push(lba); return card.readSector(lba); }, card.cardSectors);
      await fs.mount();
      const files = await fs.listBblFiles();
      assert.deepEqual(files.map((f) => [f.name, f.size]), [['BFL00001.BBL', 40116], ['BFL00002.BBL', 700], ['BFL00003.BBL', 20000]]);
      for (const f of files) {
        const lbas = await fs.fileDataSectors(f);
        assert.equal(lbas.length, Math.ceil(f.size / 512));
        const data = Buffer.concat(lbas.map((l) => Buffer.from(card.readSector(l)))).subarray(0, f.size);
        assert.deepEqual(data, Buffer.from(card.payload(f.name)), f.name);
      }
      assert.equal((await fs.fileDataSectors(files[2]))[0], card.clusterLba(10));
      assert.equal((await fs.fileDataSectors(files[2]))[32], card.clusterLba(7));
    }
  });

  await test('FAT32 root reader refuses unsafe volumes and chains', async () => {
    const files = [{ name: 'BFL00001.BBL', size: 40116, clusters: [3, 4, 5] }];
    const cases = [
      ['dirty volume', (c) => c.setFat(1, 0x07ffffff), /Dirty FAT volume/],
      ['hard error', (c) => c.setFat(1, 0x0bffffff), /hard error/],
      ['mirror mismatch', (c) => c.setFat(4, 0x0ffffff9, [2]), /FAT mirror mismatch/],
      ['cycle', (c) => c.setFat(5, 4), /longer than allocated|Cycle/],
      ['short chain', (c) => c.setFat(4, 0x0fffffff), /ended prematurely/],
      ['long chain', (c) => { c.setFat(5, 6); c.setFat(6, 0x0fffffff); }, /longer than allocated/],
      ['free cluster link', (c) => c.setFat(4, 0), /out of valid cluster range/],
      ['overlaps root', (c) => c.setFat(4, 2), /overlaps root|Cycle/],
    ];
    for (const [name, mutate, re] of cases) {
      const card = new SparseFat32Card({ files });
      mutate(card);
      const fs = new P.Fat32RootReader(async (l) => card.readSector(l), card.cardSectors);
      await assert.rejects(async () => { await fs.mount(); const [f] = await fs.listBblFiles(); await fs.fileDataSectors(f); }, re, name);
    }
    const dup = new SparseFat32Card({ files: [files[0], { name: 'BFL00001.BBL', size: 10, clusters: [9] }] });
    const fsd = new P.Fat32RootReader(async (l) => dup.readSector(l), dup.cardSectors); await fsd.mount();
    await assert.rejects(() => fsd.listBblFiles(), /Duplicate filename/);
    const gpt = new SparseFat32Card({ partition: 'mbr' }); gpt.sector(0)[446 + 4] = 0xee;
    await assert.rejects(() => new P.Fat32RootReader(async (l) => gpt.readSector(l), gpt.cardSectors).mount(), /GPT/);
    const small = new SparseFat32Card({ cardSectors: 100000 });
    await assert.rejects(() => new P.Fat32RootReader(async (l) => small.readSector(l), small.cardSectors).mount(), /minimum 65525|FAT capacity/);
    const dirCard = new SparseFat32Card(); dirCard.sector(dirCard.clusterLba(2))[11] = 0x10;
    const fsDir = new P.Fat32RootReader(async (l) => dirCard.readSector(l), dirCard.cardSectors); await fsDir.mount();
    assert.deepEqual(await fsDir.listBblFiles(), [], 'a BFL-named subdirectory is not a log file');
    const empty = new SparseFat32Card({ files: [{ name: 'BFL00009.BBL', size: 0, clusters: [3] }] });
    const fsE = new P.Fat32RootReader(async (l) => empty.readSector(l), empty.cardSectors); await fsE.mount();
    const [e] = await fsE.listBblFiles(); assert.equal(e.size, 0);
    await assert.rejects(() => fsE.fileDataSectors(e), /empty/);
    await assert.rejects(() => fsE.fileDataSectors({ ...e, size: 64 * 1024 * 1024 + 1 }), /64 MiB/);
  });

  console.log(`PASS SD download protocol layer: ${passed} tests`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
