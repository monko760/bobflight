/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
// Flasher dropdown and target catalog must offer the same boards. Host-only boards
// stay off both lists. Diagnostic profiles stay diagnostic.
import assert from 'node:assert/strict';
import { BOARD_OPTIONS } from '../src/flasher/types';
import { boardsForFamily, diagnosticProfiles, families } from '../src/targets/catalog';
import { isBoardSupported } from '../src/flasher/HexBuilder';

const catalogIds = [
  ...families.flatMap(family => boardsForFamily(family).map(board => board.id)),
  ...diagnosticProfiles.map(profile => profile.id),
].sort();
const flasher = BOARD_OPTIONS.map(board => ({
  board_id: board.boardId,
  image_profile: board.imageProfile ?? 'main',
})).sort((a, b) => a.board_id < b.board_id ? -1 : a.board_id > b.board_id ? 1 : 0);

assert.deepEqual(flasher.map(board => board.board_id), catalogIds);
assert.equal(catalogIds.includes('dummy'), false);
assert.equal(flasher.some(board => board.board_id === 'dummy'), false);
assert.equal(new Set(catalogIds).size, catalogIds.length);

for (const profile of diagnosticProfiles) {
  const row = flasher.find(board => board.board_id === profile.id);
  assert.ok(row, profile.id);
  assert.equal(row.image_profile, profile.image_profile);
  assert.notEqual(profile.image_profile, 'main', profile.id);
  assert.equal(typeof profile.artifact_name, 'string');
  assert.notEqual(profile.artifact_name, `bobflight-${profile.id}-main.hex`);
}

for (const id of catalogIds) {
  const profile = diagnosticProfiles.find(item => item.id === id);
  const custom = profile?.custom;
  const status = isBoardSupported(
    id,
    custom ? custom.mcu : '',
    custom ? String(custom.flash_kib) : '',
    custom ? String(custom.hse_hz) : '',
  );
  assert.equal(status.supported, true, id);
  assert.equal(status.isF405Diagnostic, Boolean(profile), id);
}
assert.equal(isBoardSupported('dummy', '', '', '').supported, false);

const diagnostics = diagnosticProfiles.map(profile => ({
  board_id: profile.id,
  image_profile: profile.image_profile,
  filename: profile.artifact_name,
}));
console.log(JSON.stringify({ flasher, catalogIds, diagnostics }));
console.log('PASS flasher and target catalog list the same boards');
