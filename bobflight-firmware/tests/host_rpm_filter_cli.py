# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: RPM notch filter (schema 9 keys; storage schema 10) per board.
get/set/diff/dump/defaults/save for rpm_filter_harmonics, rpm_filter_min_hz,
rpm_filter_q_x100 and motor_poles; exact refusal lines with the value left
unchanged; the exact read-only `rpm_filter` report (the host has no ESC, so
bidir-off / erpm-unavailable and every motor unavailable); harmonics > 0 never
enables bidir; save + reboot keeps the values; the full dump fits the 2048-byte export buffer."""
import os,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
RATE='4000' if board=='kakute_f7_hdv' else '1000'
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
        try: s=lines.index('rpm_filter_api: 1',i)
        except ValueError: return out
        e=lines.index('rpm_filter_end: 1',s);out.append(lines[s:e+1]);i=e+1
def expect(active,yes,reason,hz=('unavailable',)*4):
    # Frozen report: exactly these lines, in this order (no rpm_filter_harmonics line).
    return ['rpm_filter_api: 1',f'rpm_filter_active: {yes}',f'rpm_filter_reason: {reason}',f'rpm_filter_sample_hz: {RATE}',
            f'rpm_filter_harmonics_active: {active}']+[f'rpm_filter_m{m+1}_hz: {hz[m]}' for m in range(4)]+['rpm_filter_end: 1']
KEYS=['rpm_filter_harmonics','rpm_filter_min_hz','rpm_filter_q_x100','motor_poles']
DEF=['0','100','500','14']

# Defaults, exact report shape, help line.
lines=run([f'get {k}' for k in KEYS]+['rpm_filter','help'])
assert [l for l in lines if l.split('=')[0] in KEYS]==[f'{k}={v}' for k,v in zip(KEYS,DEF)],lines
assert reports(lines)==[expect(0,'no','off')],reports(lines)
assert any(l.startswith('  rpm_filter - ') for l in lines),lines

# Refusals: exact FW lines, value unchanged afterwards; accepted values echo.
cmds=['set rpm_filter_harmonics 4','set rpm_filter_harmonics -1','set rpm_filter_harmonics 1.5','set rpm_filter_harmonics abc',
      'set rpm_filter_min_hz 49','set rpm_filter_min_hz 201','set rpm_filter_q_x100 99','set rpm_filter_q_x100 1001',
      'set motor_poles 13','set motor_poles 2','set motor_poles 38','set motor_poles 0','set motor_poles 14.5']+[f'get {k}' for k in KEYS]+\
     ['set rpm_filter_harmonics 3','set rpm_filter_min_hz 50','set rpm_filter_q_x100 1000','set motor_poles 36',
      'set rpm_filter_min_hz 200','set rpm_filter_q_x100 100','set motor_poles 4']+[f'get {k}' for k in KEYS]
lines=run(cmds)
got=[l for l in lines if l.startswith(('set failed','ok rpm','ok motor'))or l.split('=')[0] in KEYS]
exp=['set failed: rpm_filter_harmonics must be 0..3','set failed: rpm_filter_harmonics must be 0..3','set failed','set failed',
     'set failed: rpm_filter_min_hz must be 50..200','set failed: rpm_filter_min_hz must be 50..200',
     'set failed: rpm_filter_q_x100 must be 100..1000','set failed: rpm_filter_q_x100 must be 100..1000',
     'set failed: motor_poles must be even, 4..36','set failed: motor_poles must be even, 4..36',
     'set failed: motor_poles must be even, 4..36','set failed: motor_poles must be even, 4..36','set failed']+\
    [f'{k}={v}' for k,v in zip(KEYS,DEF)]+\
    ['ok rpm_filter_harmonics=3','ok rpm_filter_min_hz=50','ok rpm_filter_q_x100=1000','ok motor_poles=36',
     'ok rpm_filter_min_hz=200','ok rpm_filter_q_x100=100','ok motor_poles=4']+\
    ['rpm_filter_harmonics=3','rpm_filter_min_hz=200','rpm_filter_q_x100=100','motor_poles=4']
assert got==exp,(got,lines)

# Harmonics > 0 with bidir off: accepted, reported bidir-off, bidir never enabled.
lines=run(['set rpm_filter_harmonics 2','rpm_filter','get dshot_bidir','set dshot_bidir on','rpm_filter','get erpm_m1',
           'set rpm_filter_harmonics 0','rpm_filter'])
r=reports(lines)
assert r==[expect(0,'no','bidir-off'),expect(0,'no','erpm-unavailable'),expect(0,'no','off')],r
assert lines.index('dshot_bidir=off')<lines.index('ok dshot_bidir=on') and 'erpm_m1=none' in lines,lines

# diff lists non-defaults, dump lists all four, defaults resets, storage schema 10 (schema 9 added these keys).
lines=run(['diff','set rpm_filter_harmonics 3','set motor_poles 12','diff','dump','defaults','diff','storage']+[f'get {k}' for k in KEYS])
sets=[l for l in lines if l.startswith(('set rpm_filter','set motor_poles'))]
assert sets==['set rpm_filter_harmonics 3','set motor_poles 12',
              'set rpm_filter_harmonics 3','set rpm_filter_min_hz 100','set rpm_filter_q_x100 500','set motor_poles 12'],sets
assert [l for l in lines if l.split('=')[0] in KEYS][-4:]==[f'{k}={v}' for k,v in zip(KEYS,DEF)],lines
assert values(lines,'schema')==['10'] and values(lines,'# schema')==['10']*4,lines
assert all(s.endswith(',rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles,motor_direction') for s in values(lines,'scope')+values(lines,'# scope')),lines

# Worst-case full dump (every key non-default, longest values) fits the 2048-byte export buffer (<= 2047).
big=['set rate_max_roll 1234.57','set rate_max_pitch 1234.57','set rate_max_yaw 1234.57','set rate_expo 0.123457',
     'set pid_roll_p 0.00123457','set pid_roll_i 0.00123457','set pid_roll_d 0.00123457','set pid_pitch_p 0.00123457',
     'set pid_pitch_i 0.00123457','set pid_pitch_d 0.00123457','set pid_yaw_p 0.00123457','set pid_yaw_i 0.00123457',
     'set pid_yaw_d 0.00123457','set min_throttle 0.123457','set gyro_lpf_hz 123.457','set dterm_lpf_hz 123.457',
     'set gyro_notch1_cutoff_hz 123.457','set gyro_notch1_hz 234.567','set gyro_notch2_cutoff_hz 123.457','set gyro_notch2_hz 234.567',
     'set rpm_filter_harmonics 3','set rpm_filter_min_hz 200','set rpm_filter_q_x100 1000','set motor_poles 36',
     'power_config 12.3457 123.457 1234.57 6 4.12346 3.12346 12345','dump']
out=subprocess.run([exe],input=('\n'.join(big)+'\n').encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=True).stdout.decode()
s=out.index('# bobflight_config: 1');e=out.index('# config_end: 1\r\n',s)+len('# config_end: 1\r\n')
assert 'config response failed' not in out and 'set motor_poles 36' in out[s:e],out
print(f'worst-case dump {e-s} bytes')
assert e-s<2048,e-s

# Save + reboot keeps the settings (storage saved, not dirty).
PAD=' '*64
lines=run(['set rpm_filter_harmonics 2','set rpm_filter_min_hz 80','set rpm_filter_q_x100 350','set motor_poles 12','save','reboot',PAD]+
          [f'get {k}' for k in KEYS]+['storage','rpm_filter'],reinit=True)
assert [l for l in lines if l.split('=')[0] in KEYS][-4:]==['rpm_filter_harmonics=2','rpm_filter_min_hz=80','rpm_filter_q_x100=350','motor_poles=12'],lines
assert values(lines,'state')[-1]=='saved' and values(lines,'dirty')[-1]=='0',lines
assert reports(lines)[-1]==expect(0,'no','bidir-off'),reports(lines)
print(f'PASS rpm_filter CLI ({board}, {RATE} Hz): get/set/refusals verbatim, report, bidir never auto-enabled, diff/dump/defaults, schema 10, save+reboot')
