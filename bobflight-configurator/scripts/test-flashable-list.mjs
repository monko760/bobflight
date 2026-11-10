/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
// The Configurator flashable list must match build_all_boards.py --list-flashable
// on board_id + image_profile + HEX filename. Board ids come from the catalog, not a hardcoded set.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flashableArtifacts, known, mainImageFilename, resolveBuildProfile } from './local-hex-builder.mjs';
import {
  compareFlashableLists, firmwareFlashableEntries, flashableTriples, formatMismatch, loadListFlashable,
} from './flashable-list.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const configurator = path.resolve(here, '..');
const repo = path.resolve(configurator, '..');
const catalog = require('../ui/src/targets/catalog.generated.json');

const firmware = [
  { board_id: 'alpha', image_profile: 'main', hex: 'hex/alpha/bobflight-alpha-main.hex' },
  { board_id: 'beta', image_profile: 'f405-usb-diagnostic', hex: 'artifacts/beta/abc/bobflight-beta-usb-diagnostic.hex' },
];
const configuratorList = [
  { board_id: 'beta', image_profile: 'f405-usb-diagnostic', filename: 'bobflight-beta-usb-diagnostic.hex' },
  { board_id: 'alpha', image_profile: 'main', filename: 'bobflight-alpha-main.hex' },
];

{
  const match = compareFlashableLists(configuratorList, firmware);
  assert.equal(match.ok, true, formatMismatch(match));
  assert.deepEqual(flashableTriples(configuratorList), flashableTriples(firmware));
  assert.deepEqual(
    flashableTriples([{ board_id: 'alpha', image_profile: 'main', hex: 'artifacts\\alpha\\rev\\bobflight-alpha-main.hex' }]),
    [{ board_id: 'alpha', image_profile: 'main', filename: 'bobflight-alpha-main.hex' }],
  );
  console.log('PASS exact match: board_id + image_profile + filename, ignoring CI and local publish prefixes');
}

{
  const fixture = {
    mcus: [
      { id: 'f7', family: 'F7', status: 'implemented' },
      { id: 'f4', family: 'F4', status: 'planned' },
    ],
    boards: [
      { id: 'dummy', mcu: 'f7', support: 'host-only', build_label: 'Host simulation' },
      { id: 'board_main', mcu: 'f7', support: 'development', build_label: 'Main' },
    ],
    diagnostic_profiles: [
      { id: 'board_diag', image_profile: 'f405-usb-diagnostic', artifact_name: 'bobflight-board-diag-usb-diagnostic.hex' },
      { id: 'board_custom', image_profile: 'f405-usb-diagnostic', artifact_name: 'bobflight-board-custom-usb-diagnostic.hex' },
    ],
  };
  const listed = flashableArtifacts(fixture);
  assert.equal(listed.some(entry => entry.board_id === 'dummy'), false);
  assert.deepEqual(listed.map(entry => entry.board_id), ['board_custom', 'board_diag', 'board_main']);
  assert.deepEqual(listed.find(entry => entry.board_id === 'board_custom'), {
    board_id: 'board_custom', image_profile: 'f405-usb-diagnostic', filename: 'bobflight-board-custom-usb-diagnostic.hex',
  });
  assert.notEqual(listed.find(entry => entry.board_id === 'board_diag').filename, listed.find(entry => entry.board_id === 'board_custom').filename);
  const withDummy = compareFlashableLists(
    [...configuratorList, { board_id: 'dummy', image_profile: 'main', filename: 'bobflight-dummy-main.hex' }],
    firmware,
  );
  assert.equal(withDummy.ok, false);
  assert.deepEqual(withDummy.extra, ['dummy']);
  console.log('PASS dummy is excluded');
}

{
  const missing = compareFlashableLists(configuratorList.filter(entry => entry.board_id !== 'beta'), firmware);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['beta']);
  assert.deepEqual(missing.extra, []);
  console.log('PASS missing board fails the check');
}

{
  const extra = compareFlashableLists(
    [...configuratorList, { board_id: 'gamma', image_profile: 'main', filename: 'bobflight-gamma-main.hex' }],
    firmware,
  );
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ['gamma']);
  assert.deepEqual(extra.missing, []);
  console.log('PASS extra board fails the check');
}

{
  const renamed = compareFlashableLists(configuratorList, [
    firmware[0],
    { board_id: 'beta', image_profile: 'main', hex: 'hex/beta/bobflight-beta-main.hex' },
  ]);
  assert.equal(renamed.ok, false);
  assert.deepEqual(renamed.mismatched, ['beta']);
  assert.equal(mainImageFilename('board_main'), 'bobflight-board_main-main.hex');
  console.log('PASS image_profile or filename mismatch fails the check');
}

{
  assert.throws(
    () => firmwareFlashableEntries({ schema_version: 1, ok: false, flashable: firmware }),
    /ok is not true/,
  );
  const usable = firmwareFlashableEntries({ schema_version: 1, ok: true, flashable: firmware });
  assert.equal(compareFlashableLists(configuratorList, usable).ok, true);
  const expectedOnly = firmwareFlashableEntries({ schema_version: 1, flashable: firmware });
  assert.equal(compareFlashableLists(configuratorList, expectedOnly).ok, true);
  console.log('PASS boards.json HEX list is usable only when ok is true');
}

const listed = flashableArtifacts();
assert.deepEqual([...known].sort(), listed.map(entry => entry.board_id));
assert.equal(listed.some(entry => entry.board_id === 'dummy'), false);
for (const entry of listed) {
  if (entry.image_profile === 'main') assert.equal(entry.filename, mainImageFilename(entry.board_id));
  else assert.notEqual(entry.filename, mainImageFilename(entry.board_id));
  const profile = catalog.diagnostic_profiles.find(item => item.id === entry.board_id);
  const input = {
    boardId: entry.board_id,
    customMcu: profile?.custom?.mcu ?? '',
    customFlash: profile?.custom ? String(profile.custom.flash_kib) : '',
    customHse: profile?.custom ? String(profile.custom.hse_hz) : '',
  };
  const resolved = resolveBuildProfile(input);
  assert.equal(resolved.profile, entry.image_profile);
  assert.equal(resolved.diagnostic ? resolved.artifactName : mainImageFilename(resolved.boardId), entry.filename);
}
assert.throws(() => resolveBuildProfile({ boardId: 'dummy', customMcu: '', customFlash: '', customHse: '' }));

const doc = loadListFlashable(repo);
const firmwareListed = firmwareFlashableEntries(doc);
assert.equal(firmwareListed.some(entry => entry.board_id === 'dummy'), false);
const live = compareFlashableLists(listed, firmwareListed);
if (!live.ok) throw new Error(`configurator flashable list does not match --list-flashable: ${formatMismatch(live)}`);
assert.deepEqual(flashableTriples(listed), firmwareListed);
console.log(`PASS live configurator list matches --list-flashable (${listed.length} boards)`);

const { build } = await import('esbuild');
const outfile = path.join(configurator, 'ui/scripts/test-flashable-surfaces.bundle.mjs');
try {
  await build({
    entryPoints: [path.join(configurator, 'ui/scripts/test-flashable-surfaces.tsx')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    jsx: 'automatic',
    logLevel: 'warning',
  });
  const dumped = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
  if (dumped.status !== 0) {
    throw new Error(`flasher/catalog surface check failed\n${dumped.stdout || ''}${dumped.stderr || ''}`);
  }
  const payload = JSON.parse(dumped.stdout.trim().split('\n').find(line => line.startsWith('{')));
  assert.deepEqual(payload.catalogIds, listed.map(entry => entry.board_id));
  assert.deepEqual(payload.flasher.map(entry => entry.board_id), listed.map(entry => entry.board_id));
  for (const row of payload.flasher) {
    assert.equal(row.image_profile, listed.find(entry => entry.board_id === row.board_id).image_profile);
  }
  for (const row of payload.diagnostics) {
    const entry = listed.find(item => item.board_id === row.board_id);
    assert.equal(row.image_profile, entry.image_profile);
    assert.equal(row.filename, entry.filename);
    assert.notEqual(row.image_profile, 'main');
  }
  console.log('PASS HEX builder, Flasher and target catalog list the same flashable boards');
} finally {
  await fs.rm(outfile, { force: true });
}
