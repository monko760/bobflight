#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""scripts/build_all_boards.py orchestration: every boards/*.yaml gets a result, a broken
board or a missing HEX fails the run, and the flashable list is derived from the board
definitions. Builders are replaced with fakes here; CI runs the real build separately.
Nothing is flashed."""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_all_boards as allb  # noqa: E402

YAML_IDS = sorted(p.stem for p in (ROOT / 'boards').glob('*.yaml'))


def fake_image(entry, work, log, jobs, dest):
    dest.write_text(':020000040800F2\n:0400000000000108F3\n:00000001FF\n')
    if entry['recipe'] == 'main':
        dest.with_name(dest.name + '.json').write_text('{}\n')


def fake_host(entry, work, log, jobs):
    pass


class AllBoards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / 'out'

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, builders, root=ROOT):
        with patch.dict(allb.BUILDERS, builders), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = allb.build_all(self.out, 1, root)
        index = json.loads((self.out / 'boards.json').read_text()) if (self.out / 'boards.json').exists() else None
        return code, index

    def test_plan_covers_every_yaml_with_existing_recipes(self):
        entries = {e['board_id']: e for e in allb.plan()}
        self.assertEqual(sorted(entries), YAML_IDS)
        for bid, e in entries.items():
            if e['support'] == 'host-only':
                self.assertIsNone(e['hex'], bid)
            elif e['support'] == 'diagnostic':
                self.assertEqual(e['recipe'], 'f405-usb-diagnostic')
                self.assertRegex(e['hex'], rf'^hex/{bid}/bobflight-[a-z0-9-]+\.hex$')
            else:
                self.assertEqual(e['recipe'], 'main')
                self.assertEqual(e['hex'], f'hex/{bid}/bobflight-{bid}-main.hex')

    def test_flashable_list_excludes_host_only(self):
        entries = allb.plan()
        listed = [f['board_id'] for f in allb.flashable(entries)]
        host = [e['board_id'] for e in entries if e['support'] == 'host-only']
        self.assertTrue(host)
        self.assertEqual(listed, sorted(e['board_id'] for e in entries if e['support'] != 'host-only'))

    def test_hex_for_each_expected_board(self):
        code, index = self.build({'main': fake_image, 'f405-usb-diagnostic': fake_image, 'host': fake_host})
        self.assertEqual(code, 0)
        self.assertTrue(index['ok'])
        self.assertEqual(sorted(b['board_id'] for b in index['boards']), YAML_IDS)
        for f in index['flashable']:
            self.assertTrue((self.out / f['hex']).is_file(), f)
            self.assertRegex(f['sha256'], '^[0-9a-f]{64}$')
        self.assertEqual(sorted(p.relative_to(self.out).as_posix() for p in (self.out / 'hex').rglob('*.hex')),
                         sorted(f['hex'] for f in index['flashable']))

    def test_one_failing_board_fails_the_run_and_others_still_report(self):
        def broken(entry, work, log, jobs, dest):
            if entry['board_id'] == 'matek_f722_px':
                raise allb.BuildError('cmake exited 1')
            fake_image(entry, work, log, jobs, dest)
        code, index = self.build({'main': broken, 'f405-usb-diagnostic': fake_image, 'host': fake_host})
        self.assertEqual(code, 1)
        self.assertFalse(index['ok'])
        result = {b['board_id']: b for b in index['boards']}
        self.assertEqual(result['matek_f722_px']['result'], 'failed')
        self.assertIsNone(result['matek_f722_px']['hex'])
        self.assertFalse((self.out / 'hex/matek_f722_px').exists() and any((self.out / 'hex/matek_f722_px').iterdir()))
        self.assertEqual(result['kakute_f7_hdv']['result'], 'hex')

    def test_real_command_failure_is_a_board_failure(self):
        calls = []
        def failing_run(cmd, log, cwd=None):
            calls.append(cmd)
            raise allb.BuildError('compiler exited 1')
        with patch.object(allb, 'run', failing_run):
            code, index = self.build({})
        self.assertEqual(code, 1)
        self.assertTrue(calls)
        self.assertTrue(all(b['result'] == 'failed' for b in index['boards']))
        self.assertEqual(list((self.out / 'hex').rglob('*.hex')), [])

    def test_builder_that_writes_no_hex_fails(self):
        code, index = self.build({'main': lambda *a: None, 'f405-usb-diagnostic': fake_image, 'host': fake_host})
        self.assertEqual(code, 1)
        self.assertIn('missing', {b['board_id']: b for b in index['boards']}['tmotor_f7_v2']['error'])

    def test_broken_board_yaml_fails_before_building(self):
        root = Path(self.tmp.name) / 'fw'
        for d in ('boards', 'scripts', 'targets', 'cmake'):
            shutil.copytree(ROOT / d, root / d)
        raw = (root / 'boards/tmotor_f7_v2.yaml').read_text()
        (root / 'boards/tmotor_f7_v2.yaml').write_text(raw.replace('  cs: PA4\n', '  cs: PA4\n  cs: PA4\n', 1))
        called = []
        code, index = self.build({k: (lambda *a: called.append(a)) for k in allb.BUILDERS}, root)
        self.assertEqual(code, 2)
        self.assertIsNone(index)
        self.assertEqual(called, [])

    def test_non_empty_output_refused(self):
        self.out.mkdir()
        (self.out / 'old.hex').write_text('previous')
        called = []
        code, _ = self.build({k: (lambda *a: called.append(a)) for k in allb.BUILDERS})
        self.assertEqual(code, 2)
        self.assertEqual(called, [])
        self.assertEqual((self.out / 'old.hex').read_text(), 'previous')

    def test_intel_hex_bounds(self):
        p = Path(self.tmp.name) / 'x.hex'
        p.write_text(':020000040800F2\n:0400000000000108F3\n:00000001FF\n')
        self.assertEqual(allb.check_intel_hex(p, 1024), 4)
        p.write_text(':020000040810E2\n:0400000000000108F3\n:00000001FF\n')  # 0x08100000: past 1 MiB
        with self.assertRaises(allb.BuildError):
            allb.check_intel_hex(p, 1024)
        p.write_text(':020000040800F2\n:0400000000000108F3\n')
        with self.assertRaises(allb.BuildError):
            allb.check_intel_hex(p, 1024)


if __name__ == '__main__':
    unittest.main(verbosity=2)
