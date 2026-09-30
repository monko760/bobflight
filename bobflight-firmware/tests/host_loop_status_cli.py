# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Actual host firmware CLI: frozen `status` loop-rate lines per board, the
`loop_rate` policy report, and loop_overruns == timing cycle_overruns (same
counter). Host clock, not a hardware loop-rate claim."""
import re,subprocess,sys
exe,board=sys.argv[1],sys.argv[2]
text=subprocess.run([exe],input=b'status\ntiming\nloop_rate\n',stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,timeout=20,check=True).stdout.decode()
lines=text.split('\r\n')
def one(key):
    hits=[l for l in lines if l.startswith(key+':')]
    assert len(hits)==1,(key,hits,text)
    m=re.fullmatch(re.escape(key)+r': (\S+)',hits[0])
    assert m,('key: value shape',hits[0])
    return m.group(1)
# Existing status keys are all still present, in the same key: value form.
for key in ['board','ir','mcu','usb_clk','gyro_ok','gyro_bind','dshot_bound','rx','mmio','arm',
            'failsafe','loop','flight_mode','gyro_calibrated','gyro_dps','accel_g','attitude_deg',
            'rx_uart','rx_fresh','rx_frames','channels','motor_output']:
    assert sum(1 for l in lines if l.startswith(key+': '))==1,(key,text)
expected={'dummy':'1000','tmotor_f7_v2':'1000','kakute_f7_hdv':'4000'}[board]
target=one('loop_target_hz')
assert target==expected,(board,target)
loop=[l for l in lines if l.startswith('loop: ')][0]
gyro,denom=re.fullmatch(r'loop: gyro=(\d+) Hz denom=(\d+) cascade=\d+ bg=\d+',loop).groups()
assert int(gyro)//int(denom)==int(target),(loop,target)
actual=one('loop_actual_hz')
assert actual=='unavailable' or re.fullmatch(r'(0|[1-9][0-9]*)',actual),actual
overruns=one('loop_overruns')
assert re.fullmatch(r'(0|[1-9][0-9]*)',overruns),overruns
# The three lines sit right after `loop:` so older parsers keep every old key.
i=lines.index(loop)
assert [l.split(':')[0] for l in lines[i+1:i+4]]==['loop_target_hz','loop_actual_hz','loop_overruns']
# timing printed after status: the shared since-boot counter can only grow.
cycle=one('cycle_overruns');assert int(cycle)>=int(overruns),(cycle,overruns)
assert one('gyro_config_hz')==gyro and one('pid_denom')==denom
profile={'kakute_f7_hdv':'8000/2'}.get(board,'1000/1')
assert one('loop_rate_profile')==profile and one('loop_rate_active')==f'{gyro}/{denom}'
assert one('loop_rate_reason')=='board-profile',one('loop_rate_reason')
assert 'loop_rate_end: 1' in lines
print(f'PASS host status loop lines ({board}): target {target}, actual {actual}, overruns {overruns}; loop_rate {profile}')
