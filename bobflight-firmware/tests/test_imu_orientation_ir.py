#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Synthetic IR grammar fixtures, not usable board hardware definitions."""
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from ir_codegen import parse_ir

class OrientationIR(unittest.TestCase):
    def parse(self, extra, status='ready'):
        return parse_ir('status: '+status+'\nboard_id: synthetic\nfamily: STM32F722\n'+extra,'synthetic')
    def test_four_rotations(self):
        for name in ('CW0_DEG','CW90_DEG','CW180_DEG','CW270_DEG','CW180_DEG_FLIP'):
            with self.subTest(name=name):self.assertEqual(self.parse('gyro_align: '+name+'\n')['align'],name)
    def test_quoted(self):
        self.assertEqual(self.parse('gyro_align: "CW90_DEG"\n')['align'],'CW90_DEG')
    def test_invalid(self):
        for name in ('CW45_DEG','CW0_DEG_FLIP','CW270_DEG_FLIP','cw0_deg','null',''):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):self.parse('gyro_align: '+name+'\n')
    def test_missing_physical_rejected(self):
        for status in ('bf-derived','verified','golden','ready'):
            with self.subTest(status=status):
                with self.assertRaises(ValueError):self.parse('',status)
    def test_stub_default_only(self):
        self.assertEqual(self.parse('','stub')['align'],'CW0_DEG')
    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):self.parse('gyro_align: CW0_DEG\n  gyro_align: CW270_DEG\n')
    def test_hot_path_no_alignment_parsing(self):
        source=(ROOT/'src/drivers/gyro.c').read_text()
        sample=source.split('bool gyro_sample(',1)[1].split('bool gyro_is_healthy(',1)[0]
        for forbidden in ('strcmp(', 'imu_orientation_parse(', 'board_get('):self.assertNotIn(forbidden,sample)

if __name__=='__main__':unittest.main(verbosity=2)
