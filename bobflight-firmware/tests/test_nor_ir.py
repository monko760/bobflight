#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
import sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from board_def import parse_yaml, validate, to_ir, BoardDefError
class FlashIR(unittest.TestCase):
 def setUp(self):self.raw=(ROOT/'boards/matek_f722_px.yaml').read_text()
 def load(self,raw):return to_ir(validate(parse_yaml(raw),'matek_f722_px'))
 def test_routing(self):
  ir=self.load(self.raw);self.assertEqual(ir['flash_spi'],2);self.assertEqual(ir['flash_pins'],['PB12','PB13','PB14','PC3'])
 def test_invalid_and_conflicting(self):
  cases=[self.raw.replace('nor_flash:\n  spi_bus: 2','nor_flash:\n  spi_bus: 2\n  spi_bus: 2'),
         self.raw.replace('  mosi: PC3','  mosi: PB15'),
         self.raw.replace('nor_flash:\n  spi_bus: 2','nor_flash:\n  spi_bus: 0'),
         self.raw.replace('sd: absent','sd: {spi_bus: 2, cs: PA15, sck: PB3, miso: PC12, mosi: PD2}'),
         self.raw.replace('pin: PC8','pin: PC3'),
         self.raw.replace('nor_flash:\n  spi_bus: 2\n  cs: PB12','nor_flash:\n  spi_bus: 2\n  cs: absent')]
  for raw in cases:
   self.assertNotEqual(raw,self.raw)
   with self.subTest(raw=raw[-60:]):
    with self.assertRaises(BoardDefError):self.load(raw)
if __name__=='__main__':unittest.main(verbosity=2)
