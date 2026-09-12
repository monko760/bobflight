# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Real CLI over host stdin, dummy outputs fail closed; never drives hardware."""
import subprocess,sys
exe=sys.argv[1]
def run(data):
    p=subprocess.run([exe],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,check=True)
    return p.stdout.decode()
help_text=run(b'help\n')
assert 'motor_pulse <1..4> <0..35>' in help_text
for motor in range(1,5):
    assert 'motor pulse accepted' in run(f'motor_pulse {motor} 0\n'.encode())
    assert 'motor pulse refused' in run(f'motor_pulse {motor} 35\n'.encode()) # dummy output unavailable
for cmd in ['motor_pulse 1 36','motor_pulse 1 -1','motor_pulse 1 4294967296','motor_pulse 1 0 extra','motor_pulse 0 0','motor_test 4294967296']:
    out=run((cmd+'\n').encode());assert 'accepted' not in out, (cmd,out);assert 'refused' in out
for data in [b'x'*128+b'motor_pulse 1 0\n',b'motor_pulse 1 0\0junk\n']:
    out=run(data+b'motor_test 0\n');assert 'motor pulse accepted' not in out
    assert 'invalid CLI line refused' in out;assert 'motor test accepted' in out # clean recovery
print('PASS: actual CLI help, zero stop, unavailable outputs, strict arguments, overflow/NUL discard and recovery')
