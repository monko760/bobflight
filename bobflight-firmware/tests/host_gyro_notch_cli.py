# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: manual gyro notches (schema 8) per board.
get/set/diff/dump/defaults/save conventions, the pair rule (centre 0 or
20..1000, 0 < cutoff < centre), Nyquist of the ACTUAL filter rate at `set`,
refused sets leave the value unchanged, the read-only `filters` report, and
(kakute_f7_hdv) a saved 600 Hz notch that becomes above-nyquist after a
1 kHz loop-rate change + reboot: disabled at runtime, reported, setting kept."""
import os,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
FAST=board=='kakute_f7_hdv'
RATE='8000' if FAST else '1000'   # S1: the gyro filter runs on every gyro sample (8000/2 -> 8000 Hz)
def run(cmds,reinit=False):
    env=dict(os.environ)
    if reinit: env['BOBFLIGHT_HOST_REBOOT_REINIT']='1'
    out=subprocess.run([exe],input=('\n'.join(cmds)+'\n').encode(),stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE,timeout=30,check=True,env=env).stdout.decode()
    return out.split('\r\n')
def values(lines,key):
    return [l[len(key)+2:] for l in lines if l.startswith(key+': ')]
def report(lines,i=0):
    s=lines.index('filters_api: 1',[j for j,l in enumerate(lines) if l=='filters_api: 1'][i])
    e=lines.index('filters_end: 1',s)
    return lines[s:e+1]
KEYS=['gyro_notch1_hz','gyro_notch1_cutoff_hz','gyro_notch2_hz','gyro_notch2_cutoff_hz']

# Defaults 0 / report off, exact report shape.
lines=run([f'get {k}' for k in KEYS]+['filters'])
assert [l for l in lines if l.startswith('gyro_notch')][:4]==[f'{k}=0' for k in KEYS],lines
assert report(lines)==['filters_api: 1',f'filters_sample_hz: {RATE}','gyro_notch1_active: no','gyro_notch1_reason: off',
                       'gyro_notch2_active: no','gyro_notch2_reason: off','filters_end: 1'],report(lines)

# Rejections: exact FW lines, value unchanged afterwards.
lines=run(['set gyro_notch1_hz 200','set gyro_notch1_cutoff_hz 1000','set gyro_notch1_cutoff_hz -5',
           'set gyro_notch1_cutoff_hz abc','set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 10',
           'set gyro_notch1_hz 1200','set gyro_notch1_hz 120','set gyro_notch1_hz 200',
           'set gyro_notch1_cutoff_hz 200','set gyro_notch1_cutoff_hz 0','get gyro_notch1_hz','get gyro_notch1_cutoff_hz',
           'set gyro_notch3_hz 100','get gyro_notch3_hz','filters'])
exp=['set failed: gyro_notch1_hz needs 0 < gyro_notch1_cutoff_hz < gyro_notch1_hz (set the cutoff first)',
     'set failed: gyro_notch1_cutoff_hz must be >= 0 and < 1000 while gyro_notch1_hz is 0',
     'set failed: gyro_notch1_cutoff_hz must be >= 0 and < 1000 while gyro_notch1_hz is 0',
     'set failed','ok gyro_notch1_cutoff_hz=150',
     'set failed: gyro_notch1_hz must be 0 or 20..1000','set failed: gyro_notch1_hz must be 0 or 20..1000',
     'set failed: gyro_notch1_hz needs 0 < gyro_notch1_cutoff_hz < gyro_notch1_hz (set the cutoff first)',
     'ok gyro_notch1_hz=200',
     'set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz',
     'set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz',
     'gyro_notch1_hz=200','gyro_notch1_cutoff_hz=150','unknown key','unknown key']
got=[l for l in lines if l.startswith(('set failed','ok gyro','gyro_notch1_hz=','gyro_notch1_cutoff_hz=','unknown key'))]
assert got==exp,(got,lines)
r=report(lines);assert r[2:4]==['gyro_notch1_active: yes','gyro_notch1_reason: ok'],r

# Nyquist of the actual running loop rate at `set` (limit 0.45 * rate).
lines=run(['set gyro_notch2_cutoff_hz 420','set gyro_notch2_hz 600','get gyro_notch2_hz','set gyro_notch2_hz 449','filters'])
if FAST:
    assert 'ok gyro_notch2_hz=600' in lines and 'gyro_notch2_hz=600' in lines,lines
else:
    assert 'set failed: gyro_notch2_hz must be below 450 Hz at the running 1000 Hz loop rate' in lines,lines
    assert 'gyro_notch2_hz=0' in lines,lines  # unchanged
assert 'ok gyro_notch2_hz=449' in lines,lines

# diff lists non-defaults (cutoff before centre), dump lists all, defaults resets.
lines=run(['diff','set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200.5','diff','dump','defaults','diff','storage']+[f'get {k}' for k in KEYS])
sets=[l for l in lines if l.startswith('set gyro_notch')]
assert sets==['set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200.5',
              'set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200.5','set gyro_notch2_cutoff_hz 0','set gyro_notch2_hz 0'],sets
assert 'ok gyro_notch1_hz=200.5' in lines
assert [l for l in lines if l.startswith('gyro_notch') and '=' in l][-4:]==[f'{k}=0' for k in KEYS],lines
assert values(lines,'schema')==['9'],lines  # schema 9 adds the RPM filter

# Save + reboot keeps the pair; on the 8 kHz board a 1 kHz loop change makes the
# stored 600 Hz notch above-nyquist: disabled at runtime, reported, not altered.
PAD=' '*64
if FAST:
    cmds=['set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200','set gyro_notch2_cutoff_hz 420','set gyro_notch2_hz 600',
          'filters','set loop_rate_hz 1000','save','reboot',PAD,'filters','get gyro_notch2_hz','get gyro_notch2_cutoff_hz','storage',
          'set gyro_notch2_hz 600']
else:
    cmds=['set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200','set gyro_notch2_cutoff_hz 250','set gyro_notch2_hz 300',
          'filters','save','reboot',PAD,'filters','get gyro_notch2_hz','get gyro_notch2_cutoff_hz','storage']
lines=run(cmds,reinit=True)
assert any(l.startswith('saved: ') for l in lines),lines
before,after=report(lines,0),report(lines,1)
assert before[1]==f'filters_sample_hz: {RATE}' and before[2:]==['gyro_notch1_active: yes','gyro_notch1_reason: ok',
       'gyro_notch2_active: yes','gyro_notch2_reason: ok','filters_end: 1'],before
if FAST:
    assert after==['filters_api: 1','filters_sample_hz: 1000','gyro_notch1_active: yes','gyro_notch1_reason: ok',
                   'gyro_notch2_active: no','gyro_notch2_reason: above-nyquist','filters_end: 1'],after
    assert 'gyro_notch2_hz=600' in lines and 'gyro_notch2_cutoff_hz=420' in lines,lines
    assert values(lines,'state')==['saved'] and values(lines,'dirty')==['0'],lines  # config not altered
    assert 'set failed: gyro_notch2_hz must be below 450 Hz at the running 1000 Hz loop rate' in lines,lines
else:
    assert after[1:]==before[1:],after
    assert 'gyro_notch2_hz=300' in lines and 'gyro_notch2_cutoff_hz=250' in lines,lines
print(f'PASS gyro notch CLI ({board}): defaults off, pair rule + exact rejections with value unchanged, '
      f'Nyquist at the running {RATE} Hz loop, diff/dump/defaults, save+reboot'
      + (', 600 Hz notch above-nyquist after 1 kHz loop change (runtime-disabled, setting kept)' if FAST else ''))
