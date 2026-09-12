/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {ResponseCollector,BobFlightCliClient,MockTransportFactory}=require('../dist');
async function main(){
  let result=null,err=null;
  const c=new ResponseCollector(x=>result=x,e=>err=e,{idleMs:1000,timeoutMs:2000,endMarker:'sensors_end: 1'});
  c.push('sensors_version: 1\r\nsample_seq: 42\r\nsensors_en');
  assert.equal(result,null);
  c.push('d: 1');assert.equal(result,null); // no complete marker line yet
  c.push('\r\n');assert.ok(result.includes('sample_seq: 42'));assert.equal(err,null);
  c.push('ignored');assert.ok(!result.includes('ignored'));
  let old=null;
  const legacy=new ResponseCollector(x=>old=x,()=>{}, {idleMs:1,timeoutMs:100});
  legacy.push('motor pulse accepted\r\n');assert.equal(old,null);
  await new Promise(r=>setTimeout(r,10));assert.equal(old,'motor pulse accepted\r\n');
  let unsupported=null;
  const u=new ResponseCollector(x=>unsupported=x,()=>{}, {endMarker:'sensors_end: 1'});
  u.push('unknown — try help\r\n');assert.equal(unsupported,'unknown — try help\r\n');
  const truncated=new Promise((resolve,reject)=>{
    const t=new ResponseCollector(()=>reject(new Error('accepted truncated snapshot')),e=>resolve(e),{idleMs:1,timeoutMs:10,endMarker:'sensors_end: 1'});
    t.push('sensors_version: 1\r\nsample_seq: 999\r\n');
  });
  assert.match((await truncated).message,/terminator missing/);
  let wrong=null;
  const w=new ResponseCollector(x=>wrong=x,()=>{}, {endMarker:'sensors_end: 1'});
  w.push('calibration_end: 1\r\n');assert.equal(wrong,null);w.cancel();
  const client=new BobFlightCliClient(new MockTransportFactory());
  await client.connect({path:'mock://bobflight',transport:'mock'});
  await new Promise(r=>setTimeout(r,15));
  const sensors=await client.sendCommand('sensors');
  assert.match(sensors,/sensors_end: 1/);assert.match(sensors,/sample_seq: 0/);assert.match(sensors,/sensor_config_ok: no/);
  const diagnostics=await client.sendCommand('calibration');assert.match(diagnostics,/calibration_end: 1/);assert.match(diagnostics,/ram-only/);
  for(const cmd of ['calibrate_gyro','calibrate_accel start','calibrate_accel +x','calibrate_accel -x','calibrate_accel +y','calibrate_accel -y','calibrate_accel +z','calibrate_accel -z','calibrate_accel apply']){
    assert.match(await client.sendCommand(cmd),/refused: mock IMU unavailable/);
  }
  for(const cmd of ['calibration_cancel','calibrate_accel cancel']) assert.match(await client.sendCommand(cmd),/no calibration active/);
  for(const cmd of ['sensors\nmotor_seq','calibrate_accel +X','calibrate_accel +x extra','calibrate_accel 0','calibrate_accel start\narm']){
    await assert.rejects(()=>client.sendCommand(cmd),/unsupported/);
  }
  await client.disconnect();
  console.log('PASS sensors: split terminators, immediate completion, old firmware, truncation rejection, unchanged legacy framing, exact allowlist and honest unavailable mock');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
