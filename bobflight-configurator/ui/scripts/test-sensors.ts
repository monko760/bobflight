/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import {parseKeyValueSnapshot,isSnapshotFresh,checkActionGates,AXIS_FACES,countCapturedFaces,areAllFacesCaptured,isFaceCaptured,formatVector,computeFps} from '../src/sensors/telemetry';
import {SensorRequestLane} from '../src/sensors/requestLane';
const fixture=`sensors_version: 1
sample_seq: 100
sample_ms: 12000
sensor_age_ms: 10
gyro_ok: yes
gyro_calibrated: yes
accel_calibrated: no
gyro_dps: 0.1 -0.2 0.05
accel_g: 0 0 1
accel_raw_g: 0.01 -0.02 0.99
attitude_deg: 1.5 -2 0
attitude_ready: yes
arm: disarmed
motor_active: no
sensor_config_ok: yes
cal_manual: no
cal_state: idle
cal_samples: 0
cal_required: 0
cal_faces: 0
cal_face: -1
cal_reason: idle
calibration_storage: ram-only
sensors_end: 1
`;
let passed=0;
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();console.log('PASS',name);passed++;}
async function main(){
 await test('strict full sensor schema and exact finite vectors',()=>{
  const s=parseKeyValueSnapshot(fixture)!;assert.ok(s);assert.deepEqual(s.gyro_dps,[.1,-.2,.05]);
  for(const key of ['sample_seq','sensor_age_ms','arm','motor_active','sensor_config_ok','attitude_ready','cal_manual','gyro_dps','sensors_end'])
   assert.equal(parseKeyValueSnapshot(fixture.replace(new RegExp(`^${key}:.*\\n`,'m'),'')),null,key);
  for(const v of ['NaN 0 0','Infinity 0 0','0 0','0 0 0 0','0x10 0 0'])assert.equal(parseKeyValueSnapshot(fixture.replace('0.1 -0.2 0.05',v)),null);
 });
 await test('malformed numbers/flags/version and duplicate headers fail closed',()=>{
  for(const [a,b] of [['sample_seq: 100','sample_seq: 100junk'],['sample_seq: 100','sample_seq: 4294967296'],['arm: disarmed','arm: unknown'],['motor_active: no','motor_active: maybe'],['cal_faces: 0','cal_faces: 64'],['cal_face: -1','cal_face: 6'],['sensors_version: 1','sensors_version: 2']])assert.equal(parseKeyValueSnapshot(fixture.replace(a,b)),null);
  assert.equal(parseKeyValueSnapshot(fixture+'arm: disarmed\n'),null);
 });
 await test('diagnostic vectors and ram-only indication',()=>{
  const raw=fixture.replace('sensors_end: 1','gyro_bias: 0.1 -0.2 0\naccel_bias: 0.01 0 0\naccel_scale: 1.01 1 1\nmpu_accel_config: 0x10\ncalibration_end: 1');
  assert.deepEqual(parseKeyValueSnapshot(raw)?.accel_scale,[1.01,1,1]);
  assert.equal(parseKeyValueSnapshot(raw.replace('1.01 1 1','NaN 1 1')),null);
 });
 await test('freshness expires without further replies and does not refresh repeated sequences',()=>{
  const s=parseKeyValueSnapshot(fixture)!;
  assert.ok(isSnapshotFresh(s,null,1000,1001));assert.ok(!isSnapshotFresh(s,100,1000,1001));
  assert.ok(!isSnapshotFresh(s,null,1000,1241));assert.ok(!isSnapshotFresh(s,null,1000,999));
  assert.ok(!isSnapshotFresh({...s,sample_seq:0},null,0,0));
  assert.ok(isSnapshotFresh({...s,sample_seq:1},0xffffffff,1000,1001));
  assert.ok(!isSnapshotFresh({...s,sensor_age_ms:251},null,1000,1000));
 });
 await test('disarmed, config, healthy, fresh and props-off action gates',()=>{
  const s=parseKeyValueSnapshot(fixture)!;const ctx={connected:true,snapshot:s,fresh:true,propsOff:true,stationary:true};
  assert.ok(checkActionGates('gyro_cal',ctx).allowed);
  for(const overrides of [{arm:'armed' as const},{motor_active:true},{gyro_ok:false},{sensor_config_ok:false},{sensor_config_ok:undefined},{cal_manual:true}])assert.ok(!checkActionGates('gyro_cal',{...ctx,snapshot:{...s,...overrides}}).allowed);
  for(const overrides of [{fresh:false},{propsOff:false},{stationary:false},{connected:false}])assert.ok(!checkActionGates('accel_start',{...ctx,...overrides}).allowed);
  assert.ok(checkActionGates('accel_cancel',{...ctx,fresh:false,propsOff:false,snapshot:null}).allowed);
 });
 await test('six face workflow cannot capture/apply in the wrong session',()=>{
  const s=parseKeyValueSnapshot(fixture)!;const ctx={connected:true,snapshot:s,fresh:true,propsOff:true,stationary:true};
  assert.ok(!checkActionGates('accel_face',ctx).allowed);
  const wait={...s,cal_manual:true,cal_state:'accel_wait',cal_faces:63};
  assert.ok(checkActionGates('accel_face',{...ctx,snapshot:wait}).allowed);
  assert.ok(checkActionGates('accel_apply',{...ctx,snapshot:wait}).allowed);
  assert.ok(!checkActionGates('accel_apply',{...ctx,snapshot:{...wait,cal_faces:31}}).allowed);
  assert.ok(!checkActionGates('accel_face',{...ctx,snapshot:{...wait,cal_state:'accel_collect'}}).allowed);
  assert.equal(countCapturedFaces(63),6);assert.ok(areAllFacesCaptured(63));assert.ok(isFaceCaptured(16,4));
  assert.deepEqual(AXIS_FACES.map(f=>f.key),['+x','-x','+y','-y','+z','-z']);
  assert.ok(AXIS_FACES.every(f=>!/(nose up|belly up|upright|wing down)/i.test(f.description)));
  assert.equal(formatVector([1,2,3]),'1.00, 2.00, 3.00');assert.equal(computeFps([1,501,1001],1000,1500),2);
 });
 await test('single in-flight read; action waits for current read; no poll queue',async()=>{
  const lane=new SensorRequestLane();let release!:(s:string)=>void,reads=0,actions=0;
  const read=lane.read(()=>{reads++;return new Promise<string>(r=>release=r);});await Promise.resolve();
  assert.equal(await lane.read(async()=>{reads++;return 'wrong';}),null);
  const action=lane.action(async()=>{actions++;return 'ok';});await Promise.resolve();assert.equal(actions,0);
  assert.equal(await lane.read(async()=>{reads++;return 'wrong';}),null);
  await assert.rejects(()=>lane.action(async()=>''),/pending/);
  release('sample');assert.equal(await read,'sample');assert.equal(await action,'ok');assert.equal(reads,1);assert.equal(actions,1);
 });
 await test('disconnect/visibility generations discard old results and cancel queued actions',async()=>{
  const lane=new SensorRequestLane();let release!:(s:string)=>void,actions=0;
  const read=lane.read(()=>new Promise<string>(r=>release=r));await Promise.resolve();
  const action=lane.action(async()=>{actions++;return 'bad';});const rejected=assert.rejects(()=>action,/session changed/);
  lane.invalidate();release('old data');assert.equal(await read,null);await rejected;assert.equal(actions,0);
  assert.equal(await lane.read(async()=>'new sample'),'new sample');
  const noReplay=lane.read(async()=>{actions++;return 'bad';});lane.invalidate();assert.equal(await noReplay,null);assert.equal(actions,0);
 });
 console.log(`PASS: ${passed} sensor parser, freshness, safety and request-lane groups`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
