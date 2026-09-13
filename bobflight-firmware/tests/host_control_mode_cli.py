# SPDX-License-Identifier: Apache-2.0
"""Actual host CLI; no physical outputs. New process models volatile reboot state."""
import subprocess,sys
exe=sys.argv[1]
def run(data):
    return subprocess.run([exe],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=10,check=True).stdout.decode()
def modes(text):
    return [line.split(': ',1)[1] for line in text.splitlines() if line.startswith('control_mode: ')]
assert 'control_mode [angle|acro]' in run(b'help\n')
text=run(b'control_mode\ncontrol_mode acro\ncontrol_mode\ncontrol_mode angle\ncontrol_mode\n')
assert modes(text)==['angle','acro','acro','angle','angle'],text
assert text.count('control_mode_end: 1')==5
assert 'control_mode_storage: ram-only' in text
assert 'control_mode_experimental: yes' in text
for bad in ['control_mode 2','control_mode ACRO','control_mode acro extra',
            'control_mode  acro','control_mode acro;arm','control_mode nan']:
    text=run(('control_mode acro\n'+bad+'\ncontrol_mode\n').encode())
    assert 'control_mode refused' in text,(bad,text)
    assert modes(text)==['acro','acro'],(bad,text)
for bad in [b'control_mode angle\0junk\n',b'x'*128+b'control_mode angle\n']:
    text=run(b'control_mode acro\n'+bad+b'control_mode\n')
    assert 'invalid CLI line refused' in text
    assert modes(text)==['acro','acro'],text
# Save cannot persist mode: each new host process starts with Angle.
# Host persistence may fail on unavailable flash; neither outcome can save this RAM-only field.
run(b'control_mode acro\nsave\n')
assert modes(run(b'control_mode\n'))==['angle']
text=run(b'control_mode acro\nstatus\narm\nstatus\n')
assert 'arm: disarmed' in text and 'arm refused' in text,text
assert 'arm: armed' not in text,text
print('PASS: real CLI mode query/switch, framing, malformed/overflow/NUL rejection, RAM-only restart and unchanged arm refusal')
