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
        r=TargetRegistry(self.root);self.assertEqual(len(r.mcus),5);self.assertEqual(sorted(r.boards),['dummy','kakute_f7_hdv','matek_f722_px','tmotor_f7_v2'])
        self.assertEqual(r.resolve('tmotor_f7_v2',True)['mcu']['part'],'STM32F722')
        self.assertFalse(r.boards['tmotor_f7_v2']['capabilities']['motor_output'])
    def test_unknown_board(self):
        with self.assertRaises(TargetRegistryError):TargetRegistry(self.root).resolve('unknown',True)
    def test_dummy_hardware_refused(self):
        with self.assertRaises(TargetRegistryError):TargetRegistry(self.root).resolve('dummy',True)
    def sub(self, relative, old, new):
        p=self.root/relative;t=p.read_text();self.assertIn(old,t);p.write_text(t.replace(old,new,1))
    def test_unknown_key(self):
        self.sub('boards/dummy.yaml','beeper: absent','beeper: absent\ntypo: true');self.bad()
    def test_unknown_mcu_key(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(typo=True));self.bad()
    def test_boolean_schema(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(schema_version=True));self.bad()
    def test_future_schema(self):
        self.sub('boards/dummy.yaml','schema_version: 1','schema_version: 2');self.bad()
    def test_duplicate_yaml_key(self):
        self.sub('boards/dummy.yaml','schema_version: 1','schema_version: 1\nschema_version: 1');self.bad()
    def test_duplicate_json_key(self):
        p=self.root/'targets/mcus/stm32f722.json';p.write_text(p.read_text().replace('"schema_version": 1','"schema_version": 1, "schema_version": 1'));self.bad()
    def test_renamed_identity(self):
        self.sub('boards/dummy.yaml','board_id: dummy','board_id: another');self.bad()
    def test_unknown_mcu(self):
        self.sub('boards/dummy.yaml','target: stm32f722\n  part: STM32F722','target: unknown\n  part: UNKNOWN');self.bad()
    def test_boolean_capability_required(self):
        self.sub('boards/dummy.yaml','usb_cdc: false','usb_cdc: 1');self.bad()
    def test_sensor_motor_claim(self):
        self.sub('boards/tmotor_f7_v2.yaml','motor_output: false','motor_output: true');self.bad()
    def test_unknown_status(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(status='tested'));self.bad()
    def test_core_mismatch(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(core='cortex-m4'));self.bad()
    def test_planned_toolchain(self):
        self.edit('targets/mcus/stm32f405.json',lambda d:d.update(toolchain='cmake/stm32f722.cmake'));self.bad()
    def test_missing_toolchain(self):
        self.edit('targets/mcus/stm32f722.json',lambda d:d.update(toolchain='missing.cmake'));self.bad()
    def test_resolved_paths_stay_inside(self):
        r=TargetRegistry(self.root)
        for path in ('../outside','/tmp/outside','C:/outside','boards/../../x','boards\\dummy.yaml','boards/dummy.yaml;message()'):
            with self.subTest(path=path):
                with self.assertRaises(TargetRegistryError):r.path(path)
    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as ext:
            outside=Path(ext)/'escape.yaml';outside.write_text((self.root/'boards/dummy.yaml').read_text())
            p=self.root/'boards/dummy.yaml';p.unlink()
            try:p.symlink_to(outside)
            except OSError:self.skipTest('symlinks unavailable')
            self.bad()
    def test_ir_mcu_mismatch(self):
        self.sub('boards/dummy.yaml','part: STM32F722','part: STM32F745');self.bad()
    def test_ir_identity_missing(self):
        self.sub('boards/dummy.yaml','board_id: dummy','wrong_id: dummy');self.bad()
    def test_ir_identity_duplicate(self):
        p=self.root/'boards/dummy.yaml';p.write_text(p.read_text()+'\nboard_id: dummy\n');self.bad()
    def test_host_only_cannot_claim_status(self):
        self.sub('boards/dummy.yaml','status: stub','status: bf-derived');self.bad()
    def test_new_definition_is_one_file(self):
        raw=(self.root/'boards/tmotor_f7_v2.yaml').read_text().replace('board_id: tmotor_f7_v2','board_id: synthetic_fixture').replace('display_name: ','display_name: Synthetic ',1)
        (self.root/'boards/synthetic_fixture.yaml').write_text(raw)
        r=TargetRegistry(self.root)
        self.assertEqual(r.resolve('synthetic_fixture')['board']['id'],'synthetic_fixture')
        self.assertEqual(r.resolve('synthetic_fixture')['ir_path'],'boards/synthetic_fixture.yaml')
    def test_duplicate_display_name_refused(self):
        raw=(self.root/'boards/tmotor_f7_v2.yaml').read_text().replace('board_id: tmotor_f7_v2','board_id: twin_fixture')
        (self.root/'boards/twin_fixture.yaml').write_text(raw)
        with self.assertRaisesRegex(Exception,'duplicate display_name'):TargetRegistry(self.root)
    def test_planned_board_hardware_refused(self):
        raw=(self.root/'boards/tmotor_f7_v2.yaml').read_text().replace('board_id: tmotor_f7_v2','board_id: planned_fixture').replace('display_name: ','display_name: Planned ',1).replace('target: stm32f722','target: stm32f405').replace('part: STM32F722','part: STM32F405').replace('linker_script: cmake/stm32f722.ld','linker_script: cmake/components/f405xg.ld')
        (self.root/'boards/planned_fixture.yaml').write_text(raw)
        r=TargetRegistry(self.root)
        with self.assertRaises(TargetRegistryError):r.resolve('planned_fixture',True)
    def test_diagnostic_profiles_are_not_build_targets(self):
        r=TargetRegistry(self.root)
        self.assertEqual(sorted(r.diagnostic_profiles),['custom_f405xg_usb','mltempf4'])
        for name in r.diagnostic_profiles:
            with self.assertRaises(TargetRegistryError):r.resolve(name)

if __name__=='__main__':unittest.main(verbosity=2)
