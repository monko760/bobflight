#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Isolated registry fixtures; no physical board or device access."""
import copy
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from target_registry import TargetRegistry, TargetRegistryError

class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        for folder in ('targets','boards','scripts','cmake'):
            shutil.copytree(ROOT/folder,self.root/folder,ignore=shutil.ignore_patterns('__pycache__'))
    def tearDown(self):self.tmp.cleanup()
    def edit(self, relative, change):
        p=self.root/relative;d=json.loads(p.read_text());change(d);p.write_text(json.dumps(d))
    def bad(self):
        with self.assertRaises((TargetRegistryError,ValueError)):TargetRegistry(self.root)
    def test_actual_catalog(self):
        r=TargetRegistry(self.root);self.assertEqual(len(r.mcus),5)
        self.assertEqual(r.resolve('tmotor_f7_v2',True)['mcu']['part'],'STM32F722')
        self.assertFalse(r.boards['tmotor_f7_v2']['capabilities']['motor_output'])
    def test_unknown_board(self):
        with self.assertRaises(TargetRegistryError):TargetRegistry(self.root).resolve('unknown',True)
    def test_dummy_hardware_refused(self):
        with self.assertRaises(TargetRegistryError):TargetRegistry(self.root).resolve('dummy',True)
    def test_unknown_key(self):
        self.edit('targets/boards/dummy.json',lambda d:d.update(typo=True));self.bad()
    def test_boolean_schema(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(schema_version=True));self.bad()
    def test_future_schema(self):
        self.edit('targets/boards/dummy.json',lambda d:d.update(schema_version=2));self.bad()
    def test_duplicate_json_key(self):
        p=self.root/'targets/boards/dummy.json';p.write_text(p.read_text().replace('"schema_version": 1','"schema_version": 1, "schema_version": 1'));self.bad()
    def test_renamed_identity(self):
        self.edit('targets/boards/dummy.json',lambda d:d.update(id='another'));self.bad()
    def test_unknown_mcu(self):
        self.edit('targets/boards/dummy.json',lambda d:d.update(mcu='unknown'));self.bad()
    def test_boolean_capability_required(self):
        self.edit('targets/boards/dummy.json',lambda d:d['capabilities'].update(usb_cdc=1));self.bad()
    def test_sensor_motor_claim(self):
        self.edit('targets/boards/tmotor_f7_v2.json',lambda d:d['capabilities'].update(motor_output=True));self.bad()
    def test_unknown_status(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(status='tested'));self.bad()
    def test_core_mismatch(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(core='cortex-m4'));self.bad()
    def test_planned_toolchain(self):
        self.edit('targets/mcus/stm32f405.json',lambda d:d.update(toolchain='cmake/stm32f722.cmake'));self.bad()
    def test_missing_toolchain(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(toolchain='missing.cmake'));self.bad()
    def test_paths(self):
        for path in ('../outside','/tmp/outside','C:/outside','boards/../../x','boards\\dummy.yaml','boards/dummy.yaml;message()'):
            with self.subTest(path=path):
                self.edit('targets/boards/dummy.json',lambda d:d.update(ir=path));self.bad()
    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as ext:
            outside=Path(ext)/'escape.yaml';outside.write_text('board_id: dummy\nfamily: STM32F722\n')
            p=self.root/'boards/dummy.yaml';p.unlink()
            try:p.symlink_to(outside)
            except OSError:self.skipTest('symlinks unavailable')
            self.bad()
    def test_ir_mcu_mismatch(self):
        p=self.root/'boards/dummy.yaml';p.write_text(p.read_text().replace('STM32F722','STM32F745'));self.bad()
    def test_ir_identity_missing(self):
        p=self.root/'boards/dummy.yaml';p.write_text(p.read_text().replace('board_id:', 'wrong_id:'));self.bad()
    def test_ir_identity_duplicate(self):
        p=self.root/'boards/dummy.yaml';p.write_text(p.read_text()+'\nboard_id: dummy\n');self.bad()
    def test_new_definition_is_data(self):
        board=copy.deepcopy(TargetRegistry(self.root).boards['tmotor_f7_v2'])
        board.update(id='synthetic_fixture',display_name='Synthetic host test',ir='boards/synthetic.yaml')
        raw=(self.root/'boards/tmotor-ir/tmotor_f7_v2.yaml').read_text().replace('board_id: tmotor_f7_v2','board_id: synthetic_fixture')
        (self.root/board['ir']).write_text(raw)
        (self.root/'targets/boards/synthetic_fixture.json').write_text(json.dumps(board))
        self.assertEqual(TargetRegistry(self.root).resolve('synthetic_fixture')['board']['id'],'synthetic_fixture')
    def test_planned_board_hardware_refused(self):
        board=copy.deepcopy(TargetRegistry(self.root).boards['tmotor_f7_v2'])
        board.update(id='planned_fixture',mcu='stm32f405',ir='boards/planned.yaml')
        raw=(self.root/'boards/tmotor-ir/tmotor_f7_v2.yaml').read_text().replace('board_id: tmotor_f7_v2','board_id: planned_fixture').replace('STM32F722','STM32F405')
        (self.root/board['ir']).write_text(raw)
        (self.root/'targets/boards/planned_fixture.json').write_text(json.dumps(board))
        r=TargetRegistry(self.root)
        with self.assertRaises(TargetRegistryError):r.resolve('planned_fixture',True)

if __name__=='__main__':unittest.main(verbosity=2)
