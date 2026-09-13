# SPDX-License-Identifier: Apache-2.0
import subprocess,sys,re
exe=sys.argv[1]
def run(commands):
 p=subprocess.run([exe],input=commands.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=10)
 return p.stdout.decode()
def snapshots(text):return re.findall(r'modes_api: 2\r?\n[\s\S]*?modes_end: 1',text)
def verify(text):
 assert 'arm_semantics: preview' in text
 assert 'semantics: bench-control' in text
 assert 'flight_enabled: 0' in text
 assert 'calibration_active: 0' in text
 assert 'armed: 0' in text
 assert len(re.findall(r'^mode: ',text,re.M))==4
 for row in ['ARM','ANGLE','ACRO','HORIZON']:assert f'mode: {row},' in text
text=run('modes\ncontrol_source aux\nmode_range HORIZON 1 2 1301 1700\nmode_range ACRO 1 2 1701 2100\ncontrol_source manual\ncontrol_mode horizon\nmodes\n')
ss=snapshots(text);assert len(ss)==6,text
for snap in ss:verify(snap)
assert 'control_source: manual' in ss[0] and 'requested_mode: angle' in ss[0]
assert 'control_source: aux' in ss[1] and 'requested_mode: angle' in ss[1] # no fresh host RX
assert 'requested_mode: horizon' in ss[-1]
assert 'mode: HORIZON,1,2,1301,1700,0' in ss[-1]
assert 'mode: ACRO,1,2,1701,2100,0' in ss[-1]
for bad in ['control_source AUX','control_source aux extra','control_source auto','control_source 1','control_mode level extra','mode_range HORIZON 1 13 1000 2000','mode_range ACRO 1 2 1500 1500']:
 t=run('control_source aux\n'+bad+'\nmodes\n');assert 'refused' in t,(bad,t);assert 'control_source: aux' in snapshots(t)[-1]
t=run('modes\n');assert 'control_source: manual' in t and 'requested_mode: angle' in t
assert 'mode: HORIZON,0,2,900,2100,0' in t and 'mode: ACRO,0,2,900,2100,0' in t
print('PASS real flight modes CLI: v2 framing, four rows, source opt-in, horizon manual, guards, stale-RX fallback, cold-start defaults')
