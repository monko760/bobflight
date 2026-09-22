/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadUiTs } = require('./load-ui-ts.cjs');
const {
  BobFlightCliClient,
  MockTransportFactory,
  isR0bDshotCliCommand,
} = require('../dist');

const U = loadUiTs(path.resolve(__dirname, '../../ui/src/protocol/types.ts'));

async function main() {
  const ok = [
    'get erpm_m1', 'get erpm_m2', 'get erpm_m3', 'get erpm_m4',
    'get dshot_telem_m1', 'get dshot_telem_m4',
    'get dshot_bidir',
    'set dshot_bidir on', 'set dshot_bidir off',
    'GET ERPM_M1', '  set   dshot_bidir   on  ',
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

  const client = new BobFlightCliClient(new MockTransportFactory());
  await client.connect({ path: 'mock://bobflight' });
  await new Promise((r) => setTimeout(r, 60));
  assert.match(await client.sendCommand('get erpm_m1'), /erpm_m1=none/);
  assert.match(await client.sendCommand('get erpm_m4'), /unknown key/);
  assert.match((await client.sendCommand('get dshot_telem_m1')).trim(), /^none$/);
  assert.match(await client.sendCommand('get dshot_bidir'), /dshot_bidir=off/);
  assert.match(await client.sendCommand('set dshot_bidir on'), /ok dshot_bidir=on/);
  assert.match(await client.sendCommand('get dshot_bidir'), /dshot_bidir=on/);
  assert.match(await client.sendCommand('set dshot_bidir off'), /ok dshot_bidir=off/);
  await assert.rejects(client.sendCommand('get erpm_m5'), /unsupported/);
  await assert.rejects(client.sendCommand('set dshot_bidir yes'), /unsupported/);
  await client.disconnect();
  console.log('PASS R0b CLI parse + mock get/set erpm/telem/bidir');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
