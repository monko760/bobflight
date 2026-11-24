/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
// Compare the Configurator flashable list to build_all_boards.py --list-flashable.
// Identity is board_id + image_profile + HEX filename. The CI hex/<board_id>/ prefix
// and the local builder's publish directory are not part of the comparison.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function hexFilename(hexPath) {
  const parts = String(hexPath).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function normalizeEntry(entry) {
  if (!entry || typeof entry.board_id !== 'string' || !/^[a-z0-9_-]+$/.test(entry.board_id)) {
    throw new Error('flashable entry is missing board_id');
  }
  if (typeof entry.image_profile !== 'string' || !entry.image_profile) {
    throw new Error(`flashable entry ${entry.board_id} is missing image_profile`);
  }
  const rawName = entry.filename ?? entry.hex;
  if (typeof rawName !== 'string' || !rawName) {
    throw new Error(`flashable entry ${entry.board_id} is missing a HEX filename`);
  }
  const filename = hexFilename(rawName);
  if (!filename || !filename.endsWith('.hex')) {
    throw new Error(`flashable entry ${entry.board_id} has no HEX filename`);
  }
  return { board_id: entry.board_id, image_profile: entry.image_profile, filename };
}

function byBoardId(a, b) {
  if (a.board_id < b.board_id) return -1;
  if (a.board_id > b.board_id) return 1;
  return 0;
}

export function flashableTriples(entries) {
  if (!Array.isArray(entries)) throw new Error('flashable list is not an array');
  const triples = entries.map(normalizeEntry);
  const ids = triples.map(e => e.board_id);
  if (new Set(ids).size !== ids.length) throw new Error('flashable list has a duplicate board_id');
  return triples.sort(byBoardId);
}

/** boards.json names built HEX files only when ok is true. --list-flashable has no ok field. */
export function firmwareFlashableEntries(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Invalid flashable document');
  if (doc.schema_version !== 1 || !Array.isArray(doc.flashable)) throw new Error('Invalid flashable document');
  if (Object.prototype.hasOwnProperty.call(doc, 'ok') && doc.ok !== true) {
    throw new Error('boards.json ok is not true; built HEX files are not usable');
  }
  return flashableTriples(doc.flashable);
}

export function compareFlashableLists(configuratorEntries, firmwareEntries) {
  let left, right, error;
  try {
    left = flashableTriples(configuratorEntries);
    right = flashableTriples(firmwareEntries);
  } catch (e) {
    return { ok: false, missing: [], extra: [], mismatched: [], error: e.message };
  }
  const leftIds = new Set(left.map(e => e.board_id));
  const rightIds = new Set(right.map(e => e.board_id));
  const missing = right.filter(e => !leftIds.has(e.board_id)).map(e => e.board_id);
  const extra = left.filter(e => !rightIds.has(e.board_id)).map(e => e.board_id);
  const mismatched = [];
  for (const entry of left) {
    const other = right.find(e => e.board_id === entry.board_id);
    if (other && (other.image_profile !== entry.image_profile || other.filename !== entry.filename)) mismatched.push(entry.board_id);
  }
  return { ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0, missing, extra, mismatched, error };
}

export function formatMismatch(result) {
  const parts = [];
  if (result.error) parts.push(result.error);
  if (result.missing?.length) parts.push(`missing from configurator: ${result.missing.join(', ')}`);
  if (result.extra?.length) parts.push(`extra in configurator: ${result.extra.join(', ')}`);
  if (result.mismatched?.length) parts.push(`board_id/image_profile/filename mismatch: ${result.mismatched.join(', ')}`);
  return parts.join('; ') || 'flashable lists differ';
}

export function loadListFlashable(repo) {
  const script = path.join(repo, 'bobflight-firmware/scripts/build_all_boards.py');
  const result = spawnSync('python3', [script, '--list-flashable'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'list-flashable failed').trim());
  return JSON.parse(result.stdout);
}
