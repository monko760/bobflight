#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Synthetic HEX packaging tests only. Fixtures are NOT executable firmware."""
import hashlib
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import publish_target_image as publisher

def record(kind,address,data):
    raw=bytes([len(data)])+address.to_bytes(2,'big')+bytes([kind])+data
    return ':'+(raw+bytes([-sum(raw)&255])).hex().upper()+'\n'

def fixture():
    body=bytearray([255]*256)
    body[:8]=struct.pack('<II',0x20010000,0x08000081)
    marker=b'tmotor_f7_v2\x000.2.0-prototype-tmotorf7v2-sensor2-bl1-calstore2-flightdev1\x00'
    body[8:8+len(marker)]=marker
    return (record(4,0,b'\x08\x00')+''.join(record(0,i,body[i:i+16]) for i in range(0,len(body),16))+record(1,0,b'')).encode()

class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.image=self.root/'synthetic.hex';self.image.write_bytes(fixture());self.out=self.root/'output'
    def tearDown(self):self.tmp.cleanup()
    def test_verified_pair(self):
        published=publisher.publish('tmotor_f7_v2',self.image,self.out)
        m=published['manifest'];directory=Path(published['directory'])
        data=(directory/m['file']).read_bytes()
        self.assertEqual(data,fixture());self.assertEqual(m['sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(json.loads((directory/(m['file']+'.json')).read_text()),m)
        self.assertFalse(m['hardware_qualified']);self.assertFalse(m['board']['capabilities']['motor_output'])
        self.assertEqual(m['mcu']['part'],'STM32F722')
    def test_bad_image_preserves_previous_files(self):
        self.out.mkdir();old=self.out/'keep.hex';old.write_bytes(b'previous')
        self.image.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):publisher.publish('tmotor_f7_v2',self.image,self.out)
        self.assertEqual(old.read_bytes(),b'previous');self.assertEqual(len(list(self.out.iterdir())),1)
    def test_unknown_and_host_targets_never_publish(self):
        for target in ('unknown','dummy'):
            with self.assertRaises(ValueError):publisher.publish(target,self.image,self.out)
            self.assertFalse(self.out.exists())
    def test_same_bytes_after_concurrent_rebuild(self):
        original=publisher.validate
        def changed(path,target):
            result=original(path,target)
            self.image.write_bytes(b'input changed during packaging')
            return result
        with patch.object(publisher,'validate',side_effect=changed):
            published=publisher.publish('tmotor_f7_v2',self.image,self.out)
        self.assertEqual((Path(published['directory'])/published['manifest']['file']).read_bytes(),fixture())

    def test_interrupted_publish_exposes_no_half_pair(self):
        with patch.object(publisher.os,'rename',side_effect=OSError('simulated interruption')):
            with self.assertRaises(OSError):publisher.publish('tmotor_f7_v2',self.image,self.out)
        self.assertEqual(list(self.out.rglob('*.hex')),[])
        self.assertEqual(list(self.out.rglob('*.json')),[])
    def test_identical_publish_is_idempotent(self):
        first=publisher.publish('tmotor_f7_v2',self.image,self.out)
        second=publisher.publish('tmotor_f7_v2',self.image,self.out)
        self.assertEqual(first,second)

if __name__=='__main__':unittest.main(verbosity=2)
