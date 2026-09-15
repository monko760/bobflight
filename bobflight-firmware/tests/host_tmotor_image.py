#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Synthetic HEX fixtures only: never creates executable firmware."""
import importlib.util,struct,tempfile,sys
from pathlib import Path
root=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('checker',root/'scripts/check_tmotor_image.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def rec(address,kind,data):
 b=bytes([len(data),address>>8,address&255,kind])+data
 return ':'+(b+bytes([-sum(b)&255])).hex()
def fixture(sp=0x20010000,reset=0x08000009,marker=b'tmotor_f7_v2\0' b'0.2.0-prototype-tmotorf7v2-sensor2-bl1-calstore2-flightdev1\0'):
 return [rec(0,4,b'\x08\x00'),rec(0,0,struct.pack('<II',sp,reset)),rec(8,0,marker),rec(0,1,b'')]
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'synthetic.txt'
 def check(lines,valid,board="tmotor_f7_v2"):
  p.write_text('\n'.join(lines)+'\n')
  try:m.validate(p,board)
  except (ValueError,KeyError):assert not valid;return
  assert valid
 check(fixture(),True)
 holy=fixture(marker=b'kakute_f7_hdv\0' b'0.2.0-prototype-flightdev1-bl1-calstore2-piddiag2\0')
 check(holy,True,'kakute_f7_hdv')
 check(holy,False,'tmotor_f7_v2')
 check(fixture(),False,'kakute_f7_hdv')
 check(fixture(),False,'unknown')
 for lines in [fixture(sp=0x20050000),fixture(reset=0x08000008),fixture(reset=0x08070001),fixture(marker=b'wrong-board'),fixture()[:-1],fixture()+[rec(0,1,b'')],fixture()[:2]+[fixture()[1]]+fixture()[2:], [rec(0,4,b'\x08\x08')]+fixture()[1:],fixture()[:-1]+[rec(0,5,b'\x20\x00\x00\x01')]+fixture()[-1:]]:check(lines,False)
 bad=fixture();bad[1]=bad[1][:-2]+'ff';check(bad,False)
print('PASS synthetic F7 HEX validator (both boards): correct markers/vectors/bounds, wrong stack/reset/target/entry, missing or duplicate EOF, overlap, checksum rejected')
