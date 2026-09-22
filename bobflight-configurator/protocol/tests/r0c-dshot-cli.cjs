/* Copyright 2026 Robert Leclercq - SPDX-License-Identifier: Apache-2.0 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadUiTs } = require('./load-ui-ts.cjs');
const {
  BobFlightCliClient,
  MockTransportFactory,
  isR0bDshotCliCommand,
  DSHOT_TELEM_STATUSES,
} = require('../dist');

const U = loadUiTs(path.resolve(__dirname, '../../ui/src/protocol/types.ts'));

async function main() {
  // Allowlist: m1 AND m2..m4 + bidir (fail-closed junk).
  const ok = [
    'get erpm_m1', 'get erpm_m2', 'get erpm_m3', 'get erpm_m4',
    'get dshot_telem_m1', 'get dshot_telem_m2', 'get dshot_telem_m3', 'get dshot_telem_m4',
    'get dshot_bidir',
    'set dshot_bidir on', 'set dshot_bidir off',
    'GET ERPM_M2', '  set   dshot_bidir   off  ',
  ];
  for (const raw of ok) {
    const want = raw.trim().toLowerCase().replace(/ +/g, ' ');
    assert.equal(U.parseCliInput(raw), want, raw);
    assert.equal(isR0bDshotCliCommand(want), true, want);
  }
  const junk = [
    'get erpm_m5', 'get erpm_m0', 'get erpm_m1 extra',
    'get dshot_telem_m9', 'set dshot_bidir', 'set dshot_bidir yes',
    'set dshot_bidir on\narm', 'get erpm_m1\r', 'get erpm_m1;arm',
    'get erpm', 'set dshot_bidir ON extra',
  ];
  for (const raw of junk) {
    assert.equal(U.parseCliInput(raw), null, `junk must null: ${JSON.stringify(raw)}`);
  }

  assert.deepEqual(
    [...DSHOT_TELEM_STATUSES].sort(),
    ['crc_fail', 'invalid', 'none', 'ok', 'stale', 'timeout'].sort(),
  );

  // Default mock: bidir off → all motors none (no invented erpm).
  const client = new BobFlightCliClient(new MockTransportFactory());
  await client.connect({ path: 'mock://bobflight' });
  await new Promise((r) => setTimeout(r, 60));
  for (const n of [1, 2, 3, 4]) {
    assert.match(await client.sendCommand(`get erpm_m${n}`), new RegExp(`erpm_m${n}=none`));
    assert.match((await client.sendCommand(`get dshot_telem_m${n}`)).trim(), /^none$/);
  }
  assert.match(await client.sendCommand('get dshot_bidir'), /dshot_bidir=off/);
  assert.match(await client.sendCommand('set dshot_bidir on'), /ok dshot_bidir=on/);
  assert.match(await client.sendCommand('get dshot_bidir'), /dshot_bidir=on/);

  // Bidir on fixtures: m1 ok+erpm; m2..m4 non-ok → erpm none (no invent).
  assert.match((await client.sendCommand('get dshot_telem_m1')).trim(), /^ok$/);
  assert.match(await client.sendCommand('get erpm_m1'), /erpm_m1=24600/);
  assert.match((await client.sendCommand('get dshot_telem_m2')).trim(), /^crc_fail$/);
  assert.match(await client.sendCommand('get erpm_m2'), /erpm_m2=none/);
  assert.match((await client.sendCommand('get dshot_telem_m3')).trim(), /^invalid$/);
  assert.match(await client.sendCommand('get erpm_m3'), /erpm_m3=none/);
  assert.match((await client.sendCommand('get dshot_telem_m4')).trim(), /^timeout$/);
  assert.match(await client.sendCommand('get erpm_m4'), /erpm_m4=none/);

  assert.match(await client.sendCommand('set dshot_bidir off'), /ok dshot_bidir=off/);
  assert.match(await client.sendCommand('get erpm_m2'), /erpm_m2=none/);
  await assert.rejects(client.sendCommand('get erpm_m5'), /unsupported/);
  await assert.rejects(client.sendCommand('set dshot_bidir yes'), /unsupported/);
  await client.disconnect();

  // Stale (+ timeout already above): override fixtures surface remaining tokens.
  const staleClient = new BobFlightCliClient(
    new MockTransportFactory({
      dshotTelemByMotor: { 1: 'stale', 2: 'timeout', 3: 'ok', 4: 'crc_fail' },
    }),
  );
  await staleClient.connect({ path: 'mock://bobflight' });
  await new Promise((r) => setTimeout(r, 60));
  assert.match(await staleClient.sendCommand('set dshot_bidir on'), /ok dshot_bidir=on/);
  assert.match((await staleClient.sendCommand('get dshot_telem_m1')).trim(), /^stale$/);
  assert.match(await staleClient.sendCommand('get erpm_m1'), /erpm_m1=none/); // not ok → none
  assert.match((await staleClient.sendCommand('get dshot_telem_m2')).trim(), /^timeout$/);
  assert.match((await staleClient.sendCommand('get dshot_telem_m3')).trim(), /^ok$/);
  assert.match(await staleClient.sendCommand('get erpm_m3'), /erpm_m3=24800/);
  await staleClient.disconnect();

  console.log('PASS R0c CLI parse + mock m1..m4 erpm/telem/bidir (no invent)');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
