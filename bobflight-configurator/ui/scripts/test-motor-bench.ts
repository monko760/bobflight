/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { BenchController, benchBlockReason, parseBenchHelp, parseDshot, assertBenchAck, MOTOR_POSITIONS, MAX_PULSE_PERCENT } from "../src/motors/benchController";
import type { CliCommand, ConnectionStatus, ParsedStatus } from "../src/protocol/types";
import { CommandGate } from "../src/protocol/commandGate";
import { MockBobFlightHost } from "../src/protocol/mockHost";

import { DEFAULT_MOTOR_POLES, MOTOR_POLES_KEY, readMotorPoles, storeMotorPoles, validMotorPoles } from "../src/motors/motorPoles";
import { parseErpmReply, parseTelemReply, detailForTelemStatus, emptyErpmCells } from "../src/motors/erpmTelemetry";
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
const ack = "motor test accepted (one second maximum)\r\n";
const ready: ParsedStatus = { raw: "", board: "test", arm: "disarmed", mmio: "allowed", dshot_bound: "4/4", motor_output: "DShot300 ready", failClosed: true, failClosedReasons: ["bench firmware: flight arming disabled"] };
function deferred<T>() { let resolve!: (t: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class FakeHost {
  commands: string[] = [];
  connection: ConnectionStatus = "connected";
  status: ParsedStatus = { ...ready };
  statusWait: Promise<ParsedStatus> | null = null;
  commandWait: Promise<string> | null = null;
  rate = 300;
  refuse = "";
  help = "  motor_pulse <1..4> <0..100>\n  motor_test <0..4>\n  motor_seq - sequence\n  dshot [300|600]";
  getConnectionStatus() { return this.connection; }
  async getStatus() { this.commands.push("status"); return this.statusWait ? this.statusWait : { ...this.status }; }
  async sendCommand(cmd: CliCommand) {
    this.commands.push(cmd);
    if (this.refuse === cmd) return "refused";
    if (this.commandWait && (cmd.startsWith("motor_test ") || cmd.startsWith("motor_pulse ")) && cmd !== "motor_test 0") return this.commandWait;
    if (cmd === "help") return this.help;
    if (cmd === "dshot") return `dshot: ${this.rate} kbps`;
    if (cmd.startsWith("dshot ")) { this.rate = Number(cmd.slice(6)); return `dshot: switched to ${this.rate} kbps`; }
    if (cmd === "motor_seq") return "sequence running: RR FR RL FL, 1s each - watch spin direction";
    if (cmd.startsWith("motor_pulse ")) return "motor pulse accepted (one second maximum)";
    // R0c: honest empty eRPM / telem (never invent 0).
    if (/^get erpm_m[1-4]$/.test(cmd)) return `${cmd.slice(4)}=none\r\n`;
    if (/^get dshot_telem_m[1-4]$/.test(cmd)) return "none\r\n";
    return ack;
  }
}
async function setup() {
  const host = new FakeHost(); let now = 100;
  const c = new BenchController(host, () => now);
  c.connection(true); await c.poll(); c.confirmProps(true); c.confirmStationary(true);
  host.commands = [];
  return { host, c, advance: (ms: number) => { now += ms; }, now: () => now };
}
async function main() {
  await test("capabilities are exact help-line tokens; old firmware stays unsupported", () => {
    assert.deepEqual(parseBenchHelp("  motor_test <0..4>\n mention motor_seq"), { individual: true, pulse: false, sequence: false, dshot: false });
    assert.equal(parseBenchHelp("  motor_sequence - nope").sequence, false);
    assert.equal(parseDshot("dshot: 600 kbps\r\n"), 600);
    assert.throws(() => parseDshot("DShot300 ready"));
    assert.throws(() => parseDshot("dshot: 600 kbps\nrefused"));
    assert.throws(() => assertBenchAck("motor_test 1", "ok"));
    assert.throws(() => assertBenchAck("motor_seq", "motor_seq refused"));
    assert.throws(() => assertBenchAck("dshot 600", "dshot: switched to 300 kbps"));
    assert.deepEqual(MOTOR_POSITIONS.map(m => m.motor), [4,2,3,1]);
  });
  await test("fresh hardware, props-off and stationary gates; bench-only failClosed is NOT a motor gate", async () => {
    const { c, now, advance } = await setup(); assert.equal(benchBlockReason(c.state, now()), null);
    for (const [field, value] of [["arm","armed"],["mmio","denied"],["dshot_bound","3/4"],["motor_output","unavailable"]]) {
      assert.ok(benchBlockReason({ ...c.state, status: { ...ready, [field]: value } }, now()));
    }
    c.confirmProps(false); assert.ok(benchBlockReason(c.state, now()));
    c.confirmProps(true); c.confirmStationary(false); assert.ok(benchBlockReason(c.state, now()));
    c.confirmStationary(true); advance(1501); assert.ok(benchBlockReason(c.state, now()));
  });
  await test("single pulse uses fresh status, locks rate/starts, does not auto-restart", async () => {
    const { c, host, advance } = await setup();
    await c.start(1); assert.deepEqual(host.commands, ["status","motor_test 1"]);
    assert.equal(c.state.stationary, false);
    await c.setRate(600); await c.start(2); assert.equal(host.commands.length, 2);
    advance(2000); await c.poll(); await c.start(2);
    assert.equal(host.commands.filter(x => x.startsWith("motor_test")).length, 1);
    c.confirmStationary(true); await c.start(2);
    assert.equal(host.commands.at(-1), "motor_test 2");
  });
  await test("sequence lock spans gaps, then requires physical stationary confirmation", async () => {
    const { c, host, advance } = await setup(); await c.start("sequence");
    advance(1500); await c.poll(); c.confirmStationary(true); assert.equal(c.state.stationary,false);
    await c.setRate(600); assert.ok(!host.commands.includes("dshot 600"));
    advance(5600); await c.poll(); assert.equal(c.state.stationary,false);
    c.confirmStationary(true); await c.setRate(600); assert.equal(c.state.rate,600);
  });
  await test("Stop cancels a start awaiting preflight; no queued start or overlap", async () => {
    const { c, host } = await setup(); const d = deferred<ParsedStatus>(); host.statusWait=d.promise;
    const start=c.start(1); await Promise.resolve();
    const stop=c.stop(); const second=c.start(2);
    d.resolve({ ...ready }); await Promise.all([start,stop,second]);
    assert.deepEqual(host.commands,["status","motor_test 0"]);
    assert.equal(c.state.stationary,false); assert.equal(c.state.busy,false);
  });
  await test("Stop during a sent test waits for reply then sends stop; repeated Stop is coalesced", async () => {
    const { c, host } = await setup(); const d=deferred<string>(); host.commandWait=d.promise;
    const start=c.start(3); for(let i=0;i<8;i++) await Promise.resolve();
    assert.ok(host.commands.includes("motor_test 3"));
    const stop=c.stop(); const again=c.stop();
    assert.ok(!host.commands.includes("motor_test 0"));
    d.resolve(ack); await Promise.all([start,stop,again]);
    assert.equal(host.commands.filter(x=>x==="motor_test 0").length,1);
  });
  await test("disconnect/reconnect discards pending starts and stops, resets confirmations and rate", async () => {
    const { c, host }=await setup(); const d=deferred<ParsedStatus>(); host.statusWait=d.promise;
    const start=c.start(1); await Promise.resolve(); const stop=c.stop();
    host.connection="disconnected";c.connection(false);host.connection="connected";c.connection(true);
    d.resolve({ ...ready }); await Promise.all([start,stop]);
    assert.deepEqual(host.commands,["status"]);assert.equal(c.state.propsOff,false);assert.equal(c.state.rate,null);assert.equal(c.state.status,null);
  });
  await test("fresh preflight becoming armed prevents the write", async () => {
    const { c, host }=await setup();host.status.arm="armed";await c.start(1);
    assert.deepEqual(host.commands,["status"]);
  });
  await test("unchecking props cancels preflight even if rechecked before the reply", async () => {
    const { c, host }=await setup();const d=deferred<ParsedStatus>();host.statusWait=d.promise;
    const start=c.start(1);await Promise.resolve();c.confirmProps(false);c.confirmProps(true);
    d.resolve({ ...ready });await start;assert.deepEqual(host.commands,["status"]);
  });
  await test("hidden page cancels preflight, queues stop, never automatically resumes", async () => {
    const { c, host }=await setup();const d=deferred<ParsedStatus>();host.statusWait=d.promise;
    const start=c.start(1);await Promise.resolve();c.setVisible(false);const stop=c.stop();
    d.resolve({ ...ready });await Promise.all([start,stop]);assert.deepEqual(host.commands,["status","motor_test 0"]);
    c.setVisible(true);assert.equal(c.state.propsOff,false);await c.start(1);assert.equal(host.commands.length,2);
  });
  await test("leaving during a test requests a best-effort stop", async () => {
    const { c, host }=await setup();await c.start(2);c.leave();await c.stop();
    assert.equal(host.commands.at(-1),"motor_test 0");assert.equal(c.state.visible,false);
  });
  await test("refusal is surfaced; stop does not require readiness or props confirmation", async () => {
    const { c, host }=await setup();host.refuse="motor_test 1";await c.start(1);
    assert.match(c.state.error,/refused/);assert.equal(c.state.propsOff,false);
    await c.stop();assert.match(c.state.reply,/Stop acknowledged/);
    assert.equal(c.state.stationary,false);
  });
  await test("unknown rate readback and failed stop are never displayed as success", async () => {
    const { c, host }=await setup();host.rate=1200;await c.poll();assert.match(c.state.error,/readback/);
    host.refuse="motor_test 0";await c.stop();assert.match(c.state.error,/Stop not confirmed/);
  });
  await test("older firmware permits only advertised individual tests", async () => {
    const host=new FakeHost();host.help="  motor_test <0..4>";
    const c=new BenchController(host,()=>100);c.connection(true);await c.poll();c.confirmProps(true);c.confirmStationary(true);
    await c.setRate(600);await c.start("sequence");assert.ok(!host.commands.includes("motor_seq"));assert.ok(!host.commands.includes("dshot 600"));
    await c.start(4);assert.equal(host.commands.at(-1),"motor_test 4");assert.equal(c.state.rate,null);
  });
  await test("legacy browser mock supports DShot readback and refuses unbound motor starts", async () => {
    const host=new MockBobFlightHost({connectDelayMs:0});await host.connect({path:"mock://bobflight"});
    assert.equal(parseDshot(await host.sendCommand("dshot")),300);
    assertBenchAck("dshot 600",await host.sendCommand("dshot 600"));
    assert.equal(parseDshot(await host.sendCommand("dshot")),600);
    assert.match(await host.sendCommand("motor_seq"),/refused/);
    assert.match(await host.sendCommand("motor_test 1"),/refused/);
    assertBenchAck("motor_test 0",await host.sendCommand("motor_test 0"));await host.disconnect();
  });
  await test("shared page command gate gives Stop priority without queuing starts", async () => {
    const gate=new CommandGate(()=>1);const d=deferred<string>();const seen:string[]=[];
    const polling=gate.run(async()=>{seen.push("poll");return d.promise;});
    await Promise.resolve();await Promise.resolve();
    await assert.rejects(gate.run(async()=>{seen.push("start");return "start";}),/not queued/);
    const stop=gate.run(async()=>{seen.push("stop");return "stop";},true);
    await assert.rejects(gate.run(async()=>"new poll"),/not queued/);
    d.resolve("done");await Promise.all([polling,stop]);assert.deepEqual(seen,["poll","stop"]);
  });
  await test("shared page command gate cancels waiting Stops across reconnect", async () => {
    let session=1;const gate=new CommandGate(()=>session);const d=deferred<string>();let stopped=false;
    const poll=gate.run(()=>d.promise);await Promise.resolve();await Promise.resolve();
    const stop=gate.run(async()=>{stopped=true;return "stop";},true);
    const rejected=assert.rejects(stop,/session changed/);session++;d.resolve("done");
    await Promise.all([poll,rejected]);assert.equal(stopped,false);
  });
  await test("sliders start at zero and moving them sends no command", async () => {
    const { c, host }=await setup(); assert.equal(MAX_PULSE_PERCENT,100);
    assert.deepEqual(c.state.pulsePercent,{1:0,2:0,3:0,4:0});
    assert.equal(c.setPulsePercent(1,8),true);assert.equal(c.setPulsePercent(2,12),true);
    assert.equal(c.setPulsePercent(4,20),true);assert.deepEqual(host.commands,[]);
    assert.deepEqual(c.state.pulsePercent,{1:8,2:12,3:0,4:20});
  });
  await test("sliders reject nonintegers, nonfinite and out-of-range values without clamping", async () => {
    const { c, host }=await setup();
    for(const percent of [-1,0.1,1.5,20.1,101,1000,NaN,Infinity,-Infinity]) assert.equal(c.setPulsePercent(1,percent),false);
    assert.equal(c.state.pulsePercent[1],0);assert.deepEqual(host.commands,[]);
  });
  await test("prepared command is sent only by explicit test, with preflight, cap and pulse lock", async () => {
    const { c, host, advance }=await setup();c.setPulsePercent(3,20);await c.pulse(3);
    assert.deepEqual(host.commands,["status","motor_pulse 3 20"]);assert.equal(c.state.stationary,false);
    assert.match(c.state.testLabel,/20% command/);assert.equal(c.setPulsePercent(3,1),false);
    await c.setRate(600);assert.equal(host.commands.length,2);
    advance(1300);await c.poll();await c.pulse(3);assert.equal(host.commands.filter(x=>x.startsWith("motor_pulse")).length,1);
    c.confirmStationary(true);c.setPulsePercent(3,1);await c.pulse(3);assert.equal(host.commands.at(-1),"motor_pulse 3 1");
  });
  await test("Stop cancels adjustable preflight and zeros every prepared slider", async () => {
    const { c, host }=await setup();c.setPulsePercent(1,8);c.setPulsePercent(4,20);
    const d=deferred<ParsedStatus>();host.statusWait=d.promise;
    const pulse=c.pulse(1);await Promise.resolve();const stop=c.stop();d.resolve({...ready});await Promise.all([pulse,stop]);
    assert.deepEqual(host.commands,["status","motor_test 0"]);assert.deepEqual(c.state.pulsePercent,{1:0,2:0,3:0,4:0});
  });
  await test("zero percent is stop even without props or stationary acknowledgment", async () => {
    const { c, host }=await setup();c.confirmProps(false);c.confirmStationary(false);await c.pulse(2);
    assert.deepEqual(host.commands,["motor_test 0"]);assert.ok(!host.commands.some(x=>x.startsWith("motor_pulse")));
  });
  await test("slider setpoints can change during a read-only poll, not a start preflight", async () => {
    const { c, host }=await setup();const d=deferred<ParsedStatus>();host.statusWait=d.promise;
    const poll=c.poll();await Promise.resolve();assert.equal(c.setPulsePercent(1,8),true);
    d.resolve({...ready});await poll;
    const d2=deferred<ParsedStatus>();host.statusWait=d2.promise;const pulse=c.pulse(1);await Promise.resolve();
    assert.equal(c.setPulsePercent(1,20),false);d2.resolve({...ready});await pulse;
    assert.equal(host.commands.at(-1),"motor_pulse 1 8");
  });
  await test("disconnect, hidden page and revoked props clear prepared slider values", async () => {
    const { c, host }=await setup();c.setPulsePercent(1,9);c.confirmProps(false);assert.equal(c.state.pulsePercent[1],0);
    c.setPulsePercent(1,9);c.setVisible(false);await c.stop();assert.equal(c.state.pulsePercent[1],0);
    c.setVisible(true);c.setPulsePercent(1,9);host.connection="disconnected";c.connection(false);
    host.connection="connected";c.connection(true);assert.equal(c.state.pulsePercent[1],0);
    assert.ok(!host.commands.some(x=>x.startsWith("motor_pulse")));
  });
  await test("adjustable refusal stays a refusal and resets setpoints", async () => {
    const { c, host }=await setup();c.setPulsePercent(2,8);host.refuse="motor_pulse 2 8";await c.pulse(2);
    assert.match(c.state.error,/refused/);assert.equal(c.state.pulsePercent[2],0);assert.equal(c.state.propsOff,false);
  });
  await test("old firmware cannot silently substitute fixed 8% for a slider request", async () => {
    const host=new FakeHost();host.help="  motor_test <0..4>\n  dshot [300|600]";
    const c=new BenchController(host,()=>100);c.connection(true);await c.poll();c.confirmProps(true);c.confirmStationary(true);
    host.commands=[];assert.equal(c.setPulsePercent(1,20),false);await c.pulse(1);assert.deepEqual(host.commands,[]);
    await c.start(1);assert.equal(host.commands.at(-1),"motor_test 1");
  });
  await test("100% is accepted, 101% refused, and only an explicit Test sends 100%", async () => {
    const {c,host}=await setup();assert.equal(c.setPulsePercent(4,100),true);
    assert.equal(c.setPulsePercent(4,101),false);assert.deepEqual(host.commands,[]);
    await c.pulse(4);assert.equal(host.commands.at(-1),"motor_pulse 4 100");
  });
  await test("all 404 motor/percent setpoints prepare without sending or starting", async () => {
    const {c,host}=await setup();
    for(const motor of [1,2,3,4] as const) for(let percent=0;percent<=100;percent++) {
      assert.equal(c.setPulsePercent(motor,percent),true);
      assert.equal(c.state.pulsePercent[motor],percent);
    }
    assert.deepEqual(host.commands,[]);
  });
  await test("old 35-percent firmware refusal never causes retry or fallback", async () => {
    const {c,host}=await setup();
    host.help="  motor_pulse <1..4> <0..35>";
    host.refuse="motor_pulse 1 100";
    assert.equal(c.setPulsePercent(1,100),true);await c.pulse(1);
    assert.match(c.state.error,/refused/);assert.equal(c.state.propsOff,false);
    assert.equal(c.state.pulsePercent[1],0);
    assert.equal(host.commands.filter(x=>x.startsWith("motor_pulse")).length,1);
  });
  await test("motor poles default to 14, accept even values and persist without USB", () => {
    const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);}};
    assert.equal(DEFAULT_MOTOR_POLES,14);assert.equal(readMotorPoles(storage),14);
    for(const v of [2,12,14,16,60]) { assert.ok(validMotorPoles(v));assert.equal(storeMotorPoles(v,storage),true);assert.equal(readMotorPoles(storage),v); }
    for(const v of [0,1,13,15,14.5,62,NaN,Infinity]) { assert.equal(validMotorPoles(v),false);assert.throws(()=>storeMotorPoles(v,storage)); }
    for(const raw of ["", "garbage", "13", "Infinity", "14junk", "1e2", "-14"]) {map.set(MOTOR_POLES_KEY,raw);assert.equal(readMotorPoles(storage),14);}
    assert.equal(readMotorPoles(null),14);assert.equal(storeMotorPoles(14,null),false);
    const denied={getItem:()=>{throw new Error("denied");},setItem:()=>{throw new Error("quota");}};
    assert.equal(readMotorPoles(denied),14);assert.equal(storeMotorPoles(16,denied),false);
  });
  await test("R0c erpm parse never invents 0; telem enriches detail", () => {
    assert.deepEqual(parseErpmReply(1, "erpm_m1=none"), { value: null, detail: "Waiting telem" });
    assert.deepEqual(parseErpmReply(2, "erpm_m2=24700"), { value: 24700, detail: "Live" });
    assert.equal(parseErpmReply(3, "erpm_m3=0").value, 0); // real zero only when FW says so
    assert.equal(parseTelemReply("crc_fail\r\n"), "crc_fail");
    assert.equal(detailForTelemStatus("timeout"), "Timeout");
    assert.equal(emptyErpmCells()[4].detail, "Waiting telem");
    assert.notEqual(emptyErpmCells()[2].detail, "Waiting FW R0c");
  });
  await test("bench poll hits erpm_m1..m4 and telem when erpm is none", async () => {
    const host = new FakeHost();
    const c = new BenchController(host, () => 100);
    c.connection(true);
    await c.poll();
    for (const n of [1, 2, 3, 4] as const) {
      assert.ok(host.commands.includes(`get erpm_m${n}`), `missing erpm_m${n}`);
      assert.ok(host.commands.includes(`get dshot_telem_m${n}`), `missing telem_m${n}`);
      assert.equal(c.state.erpm[n].value, null);
      assert.equal(c.state.erpm[n].detail, "Waiting telem");
    }
  });
  console.log(`${passed} motor-bench tests passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
