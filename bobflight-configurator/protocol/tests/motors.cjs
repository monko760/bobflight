/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
const assert = require('node:assert/strict');
const { BobFlightCliClient, MockTransportFactory, MockMotorBench } = require('../dist');
async function main() {
  let now=0;
  const bench=new MockMotorBench(true,()=>now);
  assert.equal(bench.handle('dshot',false).trim(),'dshot: 300 kbps');
  assert.match(bench.handle('motor_seq',false),/sequence running/);
  now=1100;assert.match(bench.handle('dshot 600',false),/refused/); // all-off gap still locked
  assert.match(bench.handle('motor_test 4',false),/accepted/); // replace sequence
  now=2101;assert.match(bench.handle('dshot 600',false),/switched to 600/);
  assert.match(bench.handle('dshot 300',true),/refused/);
  assert.match(bench.handle('motor_test 2',true),/refused/);
  assert.match(bench.handle('motor_seq',true),/refused/);
  bench.handle('motor_seq',false);bench.handle('motor_test 0',false);
  assert.match(bench.handle('dshot 300',false),/switched/);
  bench.handle('motor_seq',false);bench.disconnect();assert.match(bench.handle('dshot 600',false),/switched/);
  bench.reset();assert.equal(bench.rate,300);
  for (let motor=1;motor<=4;motor++) for(let percent=0;percent<=35;percent++) {
    assert.match(bench.handle(`motor_pulse ${motor} ${percent}`,false),/motor pulse accepted/);
  }
  for(const cmd of ['motor_pulse 0 8','motor_pulse 5 8','motor_pulse 1 -1','motor_pulse 1 36',
    'motor_pulse 1 0.1','motor_pulse 1 100','motor_pulse 1 NaN','motor_pulse 1 8 junk',
    'motor_pulse 1 4294967296','motor_pulse 1 8\nmotor_seq']) assert.match(bench.handle(cmd,false),/refused/);
  bench.handle('motor_pulse 1 20',false);assert.match(bench.handle('dshot 600',false),/refused/);
  now+=1000;assert.match(bench.handle('dshot 600',false),/switched/);
  bench.handle('motor_seq',false);assert.match(bench.handle('motor_pulse 2 0',true),/accepted/);
  assert.match(bench.handle('dshot 300',false),/switched/);
  const unavailable=new MockMotorBench();assert.match(unavailable.handle('motor_test 1',false),/refused/);
  assert.match(unavailable.handle('motor_test 0',true),/accepted/);
  assert.match(unavailable.handle('motor_pulse 1 0',true),/accepted/);
  assert.match(unavailable.handle('motor_pulse 1 8',false),/refused/);
  console.log('PASS deterministic mock: rate readback, timed pulse, sequence gaps, replacement, stop, arm, disconnect/reset');

  const client=new BobFlightCliClient(new MockTransportFactory({benchReady:true,boardId:'mock-bench-SIMULATED'}));
  await client.connect({path:'mock://bobflight'});
  // Wait for the mock banner macrotask, not for simulated motor execution.
  await new Promise(r=>setImmediate(r));
  const help=await client.sendCommand('help');assert.match(help,/motor_seq/);assert.match(help,/dshot \[300\|600\]/);
  const status=await client.getStatus();assert.equal(status.dshot_bound,'4/4');assert.equal(status.arm,'disarmed');
  assert.equal((await client.sendCommand('dshot')).trim(),'dshot: 300 kbps');
  assert.match(await client.sendCommand('dshot 600'),/switched to 600/);
  assert.equal((await client.sendCommand('dshot')).trim(),'dshot: 600 kbps');
  for(const cmd of ['motor_test 1','motor_test 2','motor_test 3','motor_test 4']) {
    assert.match(await client.sendCommand(cmd),/accepted/);
    assert.match(await client.sendCommand('dshot 300'),/refused/);
    assert.match(await client.sendCommand('motor_test 0'),/accepted/);
  }
  assert.match(await client.sendCommand('motor_seq'),/sequence running/);
  assert.match(await client.sendCommand('motor_test 0'),/accepted/);
  assert.match(await client.sendCommand('dshot 300'),/switched to 300/);
  for(const cmd of ['motor_pulse 1 1','motor_pulse 2 8','motor_pulse 3 20','motor_pulse 4 0']) {
    assert.match(await client.sendCommand(cmd),/motor pulse accepted/);
    assert.match(await client.sendCommand('motor_test 0'),/accepted/);
  }
  for(const cmd of ['motor_pulse 1 36','motor_pulse 1 -1','motor_pulse 1 1.5',
    'motor_pulse 1 8\nmotor_seq','motor_pulse 0 8','motor_pulse 5 8','motor_pulse 1 NaN','dshot 1200' ,'dshot 600\nmotor_seq','motor_test 5','motor_seq now','motor_test -1']) {
    await assert.rejects(client.sendCommand(cmd),/unsupported CLI command/);
  }
  await client.disconnect();
  console.log('PASS real CLI client transport: typed bench commands, readback, refusal, stop, invalid/injected command rejection');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
