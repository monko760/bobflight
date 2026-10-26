# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: D1 scoped `defaults pid|rates|filters` per board.
Each defaults_key line equals the real `get <key>` reply, the end count equals
the key lines, only that group moves (props-in, align yaw 90, loop rate,
motor_poles, DShot, receiver map survive defaults + save + reboot), refusals
are exact and leave `storage` (incl. dirty) and every setting unchanged, and
`storage` carries the additive accel_cal_saved line. The host has no IMU, so
the armed/bench/calibration refusals and the calibration-survives case run in
host_defaults_scoped.c against the same handler."""
import os,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
FAST=board=='kakute_f7_hdv'
GROUPS={
 'pid':['pid_roll_p','pid_roll_i','pid_roll_d','pid_pitch_p','pid_pitch_i','pid_pitch_d','pid_yaw_p','pid_yaw_i','pid_yaw_d','min_throttle','airmode'],
 'rates':['rate_center_roll','rate_center_pitch','rate_center_yaw','rate_max_roll','rate_max_pitch','rate_max_yaw','rate_expo_roll','rate_expo_pitch','rate_expo_yaw'],
 'filters':['gyro_lpf_hz','dterm_lpf_hz','gyro_notch1_hz','gyro_notch1_cutoff_hz','gyro_notch2_hz','gyro_notch2_cutoff_hz','rpm_filter_harmonics','rpm_filter_min_hz','rpm_filter_q_x100'],
}
TUNE=['set pid_roll_p 0.004','set pid_yaw_d 0.0004','set min_throttle 0.1','set airmode 1',
      'set rate_center_roll 150','set rate_max_yaw 700','set rate_expo_pitch 0.6',
      'set gyro_lpf_hz 250','set dterm_lpf_hz 90','set gyro_notch1_cutoff_hz 150','set gyro_notch1_hz 200','set rpm_filter_harmonics 2']
TUNED={c.split()[1]:c.split()[2] for c in TUNE}
KEEP=['set motor_direction props-in','set align_board_yaw 90','set motor_poles 12','dshot 600','receiver_map TAER']+(['set loop_rate_hz 1000'] if FAST else [])
ALL=[k for g in GROUPS.values() for k in g]
OTHER=['motor_direction','align_board_yaw','motor_poles','loop_rate_hz']
PAD=' '*64
def run(cmds,reinit=False):
    env=dict(os.environ)
    if reinit: env['BOBFLIGHT_HOST_REBOOT_REINIT']='1'
    out=subprocess.run([exe],input=('\n'.join(cmds)+'\n').encode(),stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE,timeout=30,check=True,env=env).stdout.decode()
    return out.split('\r\n')
def block(lines,start,end):
    i=lines.index(start);return lines[i:lines.index(end,i)+1]
def storages(lines):
    out=[];i=0
    while 'storage_api: 1' in lines[i:]:
        s=lines.index('storage_api: 1',i);e=lines.index('storage_end: 1',s);out.append(lines[s:e+1]);i=e+1
    return out
def getmap(lines):
    return dict(l.split('=',1) for l in lines if '=' in l and l.split('=',1)[0] in ALL+OTHER)

# 1. Reply shape: group line, one key line per key in `get` format, end count == key lines.
for g,keys in GROUPS.items():
    lines=run(TUNE+[f'defaults {g}']+[f'get {k}' for k in keys])
    r=block(lines,f'defaults_group: {g}',f'defaults_end: {g} {len(keys)}')
    kl=[l for l in r if l.startswith('defaults_key: ')]
    assert len(r)==len(kl)+2 and len(kl)==len(keys),r
    assert [l[len('defaults_key: '):].split('=')[0] for l in kl]==keys,kl
    gets=lines[lines.index(r[-1])+1:][:len(keys)]
    assert [l[len('defaults_key: '):] for l in kl]==gets,(kl,gets)  # byte-identical to `get`

# 2. Only the group moves; everything outside it survives defaults + save + reboot.
for g,keys in GROUPS.items():
    lines=run(KEEP+TUNE+['save','reboot',PAD,'storage',f'defaults {g}','storage','save','reboot',PAD,'storage']+[f'get {k}' for k in ALL+OTHER],reinit=True)
    st=storages(lines);assert len(st)==3,st
    assert 'dirty: 0' in st[0] and 'dirty: 1' in st[1] and 'state: saved' in st[2],st  # no auto-save
    assert all(s[-2]=='accel_cal_saved: no' for s in st),st  # host: no IMU, so never a calibration
    v=getmap(lines[lines.index(st[2][-1]):])
    assert v['motor_direction']=='props-in' and v['align_board_yaw']=='90' and v['motor_poles']=='12',v
    assert v['loop_rate_hz']=='1000',v  # Kakute default is 4000: the saved 1000 survives
    d=run([f'get {k}' for k in ALL]);dv=getmap(d)
    for k in ALL:
        want=dv[k] if k in keys else TUNED.get(k,dv[k])
        assert v[k]==want,(g,k,v[k],want)
    assert 'dshot 600' in run(KEEP+['diff all'])  # sanity: diff carries it
    after=run(KEEP+TUNE+['save','reboot',PAD,f'defaults {g}','save','reboot',PAD,'diff all'],reinit=True)
    assert 'dshot 600' in after and 'receiver_map TAER' in after and 'set motor_direction props-in' in after,(g,after)

# 3. Refusals: exact single line, storage and every setting unchanged (dirty and clean).
REF=[('defaults','defaults_error: group_required pid|rates|filters'),('defaults bogus','defaults_error: unknown_group'),
     ('defaults PID','defaults_error: unknown_group'),('defaults pid rates','defaults_error: unknown_group'),('defaults all','defaults_error: unknown_group')]
for pre in ([],['save']):
    for cmd,want in REF:
        lines=run(KEEP+TUNE+pre+['storage']+[f'get {k}' for k in ALL+OTHER]+[cmd,'storage']+[f'get {k}' for k in ALL+OTHER])
        assert want in lines and not any(l.startswith(('defaults_group','defaults_key','defaults_end')) for l in lines),(cmd,lines)
        st=storages(lines);assert st[0]==st[1],(cmd,st)
        i=lines.index(want);assert getmap(lines[:i])==getmap(lines[i:]),cmd

# 4. One shared formatter: `get` prints six significant digits exactly, and the
#    defaults_key lines stay byte-identical to `get` (section 1).
lines=run(['set rate_center_roll 123.456','get rate_center_roll','set pid_roll_p 0.0123456','get pid_roll_p'])
assert 'rate_center_roll=123.456' in lines and 'pid_roll_p=0.0123456' in lines,lines

# 5. help documents the scoped form.
assert any(l.startswith('  defaults pid|rates|filters - ') for l in run(['help'])),'help'
print(f'PASS {board}: defaults pid|rates|filters replies == get, end count == key lines, only the group resets (props-in, align 90, loop, poles, DShot, map survive save+reboot), refusals exact and storage/dirty unchanged, accel_cal_saved present')
