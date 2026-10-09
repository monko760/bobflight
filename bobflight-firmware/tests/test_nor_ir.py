#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from ir_codegen import parse_ir
class FlashIR(unittest.TestCase):
 def setUp(self):self.raw=(ROOT/'boards/matek-ir/matek_f722_px.yaml').read_text()
 def test_routing(self):
  ir=parse_ir(self.raw,'matek');self.assertEqual(ir['flash_spi'],2);self.assertEqual(ir['flash_pins'],['PB12','PB13','PB14','PC3'])
 def test_invalid_and_conflicting(self):
  cases=[self.raw+'\nflash_spi_bus: 2\n',self.raw.replace('flash_mosi_pin: PC3','flash_mosi_pin: PB15'),self.raw.replace('flash_spi_bus: 2','flash_spi_bus: 0'),self.raw+'\nsd_spi_bus: 2\n',self.raw.replace('pin: PC8','pin: PC3')]
  for raw in cases:
   self.assertNotEqual(raw,self.raw)
   with self.subTest(raw=raw[-60:]):
    with self.assertRaises(ValueError):parse_ir(raw,'bad')
if __name__=='__main__':unittest.main(verbosity=2)
