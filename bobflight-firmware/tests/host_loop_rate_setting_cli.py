# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: persisted `loop_rate_hz` setting per board.
get/set conventions, exact 1000|4000|8000 validation, board refusal of the
8 kHz gyro path, save+reboot note, pending-reboot flag, diff/dump/defaults,
storage schema 7, and save + (host warm) reboot applying the new rate while
status loop_target_hz reports the rate actually applied."""
import os,re,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
FAST=board=='kakute_f7_hdv'
DEFAULT='4000' if FAST else '1000'
CHANGED='8000' if FAST else '1000'
def run(cmds,reinit=False):
    env=dict(os.environ)
    if reinit: env['BOBFLIGHT_HOST_REBOOT_REINIT']='1'
    out=subprocess.run([exe],input=('\n'.join(cmds)+'\n').encode(),stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE,timeout=30,check=True,env=env).stdout.decode()
    return out.split('\r\n')
def values(lines,key):
    return [l[len(key)+2:] for l in lines if l.startswith(key+': ')]
BAD_VALUE='set failed: loop_rate_hz must be 1000, 4000 or 8000'
NOTE='note: loop_rate_hz takes effect after save + reboot'

# get / default, invalid values rejected without changing the setting.
bad=['2000','4000.0','+4000','04000','4e3','abc','16000','0']
lines=run(['get loop_rate_hz']+[f'set loop_rate_hz {v}' for v in bad]+['get loop_rate_hz'])
got=[l for l in lines if l.startswith('loop_rate_hz=')]
assert got==[f'loop_rate_hz={DEFAULT}']*2,(got,lines)
assert sum(1 for l in lines if l==BAD_VALUE)==len(bad),lines

# Board support: 4000/8000 need the 8 kHz MPU6000 path (kakute_f7_hdv only).
lines=run(['set loop_rate_hz 4000','set loop_rate_hz 8000','get loop_rate_hz'])
if FAST:
    assert 'ok loop_rate_hz=4000' in lines and 'ok loop_rate_hz=8000' in lines,lines
    assert lines.count(NOTE)==2 and 'loop_rate_hz=8000' in lines,lines
else:
    for v in ('4000','8000'):
        want=f'set failed: loop_rate_hz {v} not supported on {board} (no 8 kHz gyro path)'
        assert want in lines,(want,lines)
    assert 'loop_rate_hz=1000' in lines and NOTE not in lines,lines

# A change is pending until save + reboot: the running rate never moves.
lines=run(['status',f'set loop_rate_hz {CHANGED}','loop_rate','status','storage','diff','dump'])
t=values(lines,'loop_target_hz');assert len(t)==2 and t[0]==t[1]==DEFAULT,(t,lines)
assert values(lines,'loop_rate_setting_hz')==[CHANGED],lines
assert values(lines,'loop_rate_boot_setting_hz')==[DEFAULT],lines
assert values(lines,'loop_rate_pending_reboot')==['1' if CHANGED!=DEFAULT else '0'],lines
assert values(lines,'schema')==['7'] and values(lines,'# schema')==['7','7'],lines
assert all(s.endswith(',loop_rate_hz') for s in values(lines,'scope')+values(lines,'# scope')),lines
sets=[l for l in lines if l.startswith('set loop_rate_hz ')]
# diff lists it only when it differs from the board default; dump always does.
assert sets==([f'set loop_rate_hz {CHANGED}']*2 if CHANGED!=DEFAULT else [f'set loop_rate_hz {DEFAULT}']),sets
if CHANGED!=DEFAULT: assert values(lines,'dirty')==['1'],lines

# save + reboot: the saved setting is applied at boot and reported honestly.
# Bytes behind `reboot` in the same read are dropped (as on hardware), so pad.
PAD=' '*64
lines=run([f'set loop_rate_hz {CHANGED}','save','reboot',PAD,'status','loop_rate','get loop_rate_hz',
           'defaults','get loop_rate_hz','diff','loop_rate'],reinit=True)
assert any(l.startswith('saved: ') for l in lines),lines
want_target={'8000':'8000','1000':'1000'}[CHANGED]
assert values(lines,'loop_target_hz')==[want_target],(values(lines,'loop_target_hz'),lines)
assert values(lines,'loop_rate_boot_setting_hz')==[CHANGED,CHANGED],lines
assert values(lines,'loop_rate_pending_reboot')==['0','1' if CHANGED!=DEFAULT else '0'],lines
prof=values(lines,'loop_rate_profile')[0]
assert prof==('8000/1' if FAST else '1000/1'),prof
assert values(lines,'loop_rate_reason')[0]=='setting',lines
got=[l for l in lines if l.startswith('loop_rate_hz=')]
assert got==[f'loop_rate_hz={CHANGED}',f'loop_rate_hz={DEFAULT}'],got
assert 'defaults restored' in lines
assert not [l for l in lines if l.startswith('set loop_rate_hz ')],lines  # diff after defaults
print(f'PASS loop_rate_hz CLI ({board}): default {DEFAULT}, invalid rejected, '
      f'{"8000 accepted" if FAST else "4000/8000 refused"}, pending until save+reboot, '
      f'diff/dump/defaults, schema 7, reboot applies target {want_target}')
