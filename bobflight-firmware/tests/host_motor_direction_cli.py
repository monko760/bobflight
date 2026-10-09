# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: motor_direction (schema 10) per board.
get/set/diff/dump/defaults/save + reboot, the exact refusal line for a bad
token with the value unchanged, and the exact read-only `mixer` report. The
host cannot arm (no gyro) or run a motor test (no DShot): those two refusals
are covered by host_motor_direction_cli.c against the same header."""
import os,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
def run(cmds,reinit=False):
    env=dict(os.environ)
    if reinit: env['BOBFLIGHT_HOST_REBOOT_REINIT']='1'
    out=subprocess.run([exe],input=('\n'.join(cmds)+'\n').encode(),stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE,timeout=30,check=True,env=env).stdout.decode()
    return out.split('\r\n')
def values(lines,key):
    return [l[len(key)+2:] for l in lines if l.startswith(key+': ')]
def reports(lines):
    out=[];i=0
    while True:
        try: s=lines.index('mixer_api: 1',i)
        except ValueError: return out
        e=lines.index('mixer_end: 1',s);out.append(lines[s:e+1]);i=e+1
def report(d):
    s={'props-out':['-1','+1','+1','-1'],'props-in':['+1','-1','-1','+1']}[d]
    return ['mixer_api: 1','mixer: quadx',f'motor_direction: {d}']+[f'mixer_yaw_m{i+1}: {s[i]}' for i in range(4)]+['mixer_end: 1']
INVALID='set failed: motor_direction must be props-out or props-in'

# Default, exact report, help line; set -> get -> report (immediate, no reboot).
lines=run(['get motor_direction','mixer','help','set motor_direction props-in','get motor_direction','mixer',
           'set motor_direction sideways','set motor_direction PROPS-OUT','set motor_direction','get motor_direction','mixer'])
gets=[l for l in lines if l.startswith('motor_direction=')]
assert gets==['motor_direction=props-out','motor_direction=props-in','motor_direction=props-in'],gets
assert reports(lines)==[report('props-out'),report('props-in'),report('props-in')],reports(lines)
assert 'ok motor_direction=props-in' in lines,lines
# A missing value is rejected by the generic set parser before the key hook.
assert [l for l in lines if l.startswith('set failed')]==[INVALID,INVALID,'set failed'],lines
assert any(l.startswith('  mixer - ') for l in lines),lines

# diff only when props-in; dump always; defaults -> props-out; storage schema 11 scope.
lines=run(['diff','set motor_direction props-in','diff','dump','defaults','diff','get motor_direction','storage'])
sets=[l for l in lines if l.startswith('set motor_direction')]
assert sets==['set motor_direction props-in','set motor_direction props-in'],sets
assert 'motor_direction=props-out' in lines,lines
assert values(lines,'schema')==['11'] and values(lines,'# schema')==['11']*4,lines
assert all(s.endswith(',motor_poles,motor_direction,align_board_roll,align_board_pitch,align_board_yaw') for s in values(lines,'scope')+values(lines,'# scope')),lines

# An accepted set makes storage dirty; a refused one does not.
lines=run(['save','storage','set motor_direction bogus','storage','set motor_direction props-in','storage'])
assert values(lines,'state')==['saved','saved','dirty'],values(lines,'state')

# Save + reboot keeps props-in (storage saved, not dirty); the mixer applies it after boot.
PAD=' '*64
lines=run(['set motor_direction props-in','save','reboot',PAD,'get motor_direction','storage','mixer'],reinit=True)
assert [l for l in lines if l.startswith('motor_direction=')][-1]=='motor_direction=props-in',lines
assert values(lines,'state')[-1]=='saved' and values(lines,'dirty')[-1]=='0',lines
assert reports(lines)[-1]==report('props-in'),reports(lines)
print(f'PASS motor_direction CLI ({board}): get/set/refusal verbatim, value unchanged, mixer report follows immediately, diff/dump/defaults, schema 11, save+reboot')
