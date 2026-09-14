/* Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 * Command acknowledgments are NOT motor/RPM telemetry.
 */
import type { BobFlightHost, CliCommand, ParsedStatus, MotorPulsePercent } from "../protocol/types";

export const STATUS_MAX_AGE_MS = 1500;
export const MAX_PULSE_PERCENT = 100;
export type MotorNumber = 1 | 2 | 3 | 4;
const zeroSliders = (): Record<MotorNumber, MotorPulsePercent> => ({ 1: 0, 2: 0, 3: 0, 4: 0 });
export function isPulsePercent(value: number): value is MotorPulsePercent {
  return Number.isInteger(value) && value >= 0 && value <= MAX_PULSE_PERCENT;
}
export const MOTOR_POSITIONS = [
  { motor: 4, name: "Front left", position: "front-left" },
  { motor: 2, name: "Front right", position: "front-right" },
  { motor: 3, name: "Rear left", position: "rear-left" },
  { motor: 1, name: "Rear right", position: "rear-right" },
] as const;
export interface BenchCapabilities { individual: boolean; pulse: boolean; sequence: boolean; dshot: boolean }
export function parseBenchHelp(text: string): BenchCapabilities {
  const has = (name: string) => new RegExp(`^\\s*${name}(?:\\s|$)`, "m").test(text);
  return { individual: has("motor_test"), pulse: has("motor_pulse"), sequence: has("motor_seq"), dshot: has("dshot") };
}
export function parseDshot(text: string): 300 | 600 {
  const match = /^dshot: (300|600) kbps\s*$/m.exec(text);
  if (!match || /refused|unknown|unsupported|failed/i.test(text)) throw new Error("DShot rate readback unavailable");
  return Number(match[1]) as 300 | 600;
}
export function assertBenchAck(cmd: CliCommand, text: string): void {
  if (/refused|unknown|unsupported|failed/i.test(text)) throw new Error(text.trim());
  const expected = cmd === "motor_seq"
    ? /^sequence running: RR FR RL FL, 1s each - watch spin direction\s*$/m
    : cmd.startsWith("motor_pulse ")
      ? /^motor pulse accepted \(one second maximum\)\s*$/m
    : cmd.startsWith("motor_test ")
      ? /^motor test accepted \(one second maximum\)\s*$/m
      : new RegExp(`^dshot: switched to ${cmd.slice(6)} kbps\\s*$`, "m");
  if (!expected.test(text)) throw new Error(`No recognized acknowledgment for ${cmd}; motor state is unknown. Use Stop / disconnect battery if needed.`);
}
export interface BenchState {
  connected: boolean; visible: boolean; status: ParsedStatus | null; statusAt: number;
  capabilities: BenchCapabilities | null; rate: 300 | 600 | null;
  propsOff: boolean; stationary: boolean; busy: boolean; actionPending: boolean; stopping: boolean;
  pulsePercent: Record<MotorNumber, MotorPulsePercent>;
  estimatedUntil: number; testLabel: string; reply: string; error: string;
}
const initial = (): BenchState => ({ connected: false, visible: true, status: null, statusAt: -Infinity,
  capabilities: null, rate: null, propsOff: false, stationary: false, busy: false, actionPending: false, stopping: false,
  pulsePercent: zeroSliders(), estimatedUntil: 0, testLabel: "", reply: "", error: "" });
export function benchBlockReason(s: BenchState, now: number): string | null {
  if (!s.connected) return "Connect a flight controller over USB.";
  if (!s.visible) return "Motor controls are locked while this page is hidden.";
  if (!s.status || now - s.statusAt > STATUS_MAX_AGE_MS) return "Waiting for fresh controller status.";
  if (s.status.arm !== "disarmed") return "Controller must report disarmed.";
  // Legacy firmware hardcodes DShot300 in motor_output even when running at 600.
  // Treat it only as output-health evidence; rate comes from the dshot command.
  if (!/^DShot(?:300|600)? ready$/.test(s.status.motor_output ?? "") ||
      s.status.dshot_bound !== "4/4" || !/^allowed(?:\s|$)/.test(s.status.mmio ?? ""))
    return "Four healthy motor outputs and permitted hardware access are required.";
  if (!s.propsOff) return "Confirm all props are removed and the frame is secured.";
  if (now < s.estimatedUntil) return "Test window active (estimated). Stop is always available.";
  if (!s.stationary) return "Visually confirm every motor is stationary.";
  return null;
}

/** One in-flight operation, NO queued/retried starts. Stop invalidates any not-yet-sent action. */
export class BenchController {
  state = initial();
  private generation = 0;
  private session = 0;
  private flight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private possibleMotion = false;
  private listeners = new Set<(state: BenchState) => void>();
  constructor(private host: Pick<BobFlightHost, "getStatus" | "sendCommand" | "getConnectionStatus">,
    private now: () => number = () => performance.now()) {}
  subscribe(fn: (s: BenchState) => void): () => void { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  private patch(p: Partial<BenchState>): void { this.state = { ...this.state, ...p }; this.listeners.forEach(fn => fn(this.state)); }
  connection(connected: boolean): void {
    if (connected === this.state.connected) return;
    this.generation++; this.session++; this.possibleMotion = false;
    this.patch({ ...initial(), connected, visible: this.state.visible });
  }
  confirmProps(value: boolean): void {
    this.patch({ propsOff: value, ...(value ? {} : { pulsePercent: zeroSliders() }) });
    if (!value) this.generation++;
    if (!value && this.possibleMotion) void this.stop();
  }
  confirmStationary(value: boolean): void {
    if (this.state.busy || this.now() < this.state.estimatedUntil) return;
    this.patch({ stationary: value });
    if (value) this.possibleMotion = false;
  }
  setVisible(visible: boolean): void {
    this.patch({ visible });
    if (!visible) { this.patch({ propsOff: false, stationary: false, pulsePercent: zeroSliders() }); void this.stop(); }
  }
  leave(): Promise<void> {
    this.patch({ visible: false, propsOff: false, stationary: false, pulsePercent: zeroSliders() });
    this.generation++;
    return this.possibleMotion ? this.stop() : Promise.resolve();
  }
  private valid(g: number): boolean {
    return g === this.generation && this.state.connected && this.host.getConnectionStatus() === "connected";
  }
  private async status(g: number): Promise<void> {
    const status = await this.host.getStatus();
    if (this.valid(g)) this.patch({ status, statusAt: this.now() });
  }
  private run(work: (g: number) => Promise<void>, action = false): Promise<void> {
    if (this.flight || this.stopFlight || !this.state.connected || !this.state.visible) return Promise.resolve();
    const g = this.generation;
    this.patch({ busy: true, actionPending: action });
    const p = Promise.resolve().then(async () => { if (this.valid(g)) await work(g); })
      .catch(e => { if (this.valid(g)) this.patch({ error: e instanceof Error ? e.message : String(e), status: null, rate: null, propsOff: false, stationary: false, pulsePercent: zeroSliders() }); })
      .finally(() => { if (this.flight === p) { this.flight = null; if (!this.stopFlight) this.patch({ busy: false, actionPending: false }); } });
    this.flight = p;
    return p;
  }
  poll(): Promise<void> {
    return this.run(async g => {
      await this.status(g);
      if (!this.valid(g)) return;
      if (!this.state.capabilities) {
        const help = await this.host.sendCommand("help");
        if (!this.valid(g)) return;
        this.patch({ capabilities: parseBenchHelp(help) });
      }
      if (this.state.capabilities?.dshot) {
        const raw = await this.host.sendCommand("dshot");
        if (this.valid(g)) this.patch({ rate: parseDshot(raw) });
      }
    });
  }
  /** A slider only prepares a setpoint: no USB command, no timer, no motor start. */
  setPulsePercent(motor: MotorNumber, percent: number): boolean {
    if (![1, 2, 3, 4].includes(motor) || !isPulsePercent(percent) ||
        !this.state.capabilities?.pulse || !this.state.connected || !this.state.visible ||
        this.state.actionPending || this.state.stopping || this.now() < this.state.estimatedUntil || this.possibleMotion) return false;
    this.patch({ pulsePercent: { ...this.state.pulsePercent, [motor]: percent } });
    return true;
  }
  pulse(motor: MotorNumber): Promise<void> {
    if (![1, 2, 3, 4].includes(motor) || !this.state.capabilities?.pulse) return Promise.resolve();
    const percent = this.state.pulsePercent[motor];
    if (!isPulsePercent(percent)) return Promise.resolve();
    // Zero is stop, never DShot command 48 (idle throttle). Stop bypasses readiness.
    if (percent === 0) return this.stop();
    return this.test(`motor_pulse ${motor} ${percent}`, `Motor ${motor} · ${percent}% command`, 1200);
  }
  start(motor: 1 | 2 | 3 | 4 | "sequence"): Promise<void> {
    if (!(motor === "sequence" ? this.state.capabilities?.sequence : this.state.capabilities?.individual)) return Promise.resolve();
    return this.test(motor === "sequence" ? "motor_seq" : `motor_test ${motor}`,
      motor === "sequence" ? "Sequence M1 → M2 → M3 → M4 · fixed 8%" : `Motor ${motor} · fixed 8%`,
      motor === "sequence" ? 7000 : 1200);
  }
  private test(cmd: CliCommand, label: string, duration: number): Promise<void> {
    if (benchBlockReason(this.state, this.now())) return Promise.resolve();
    return this.run(async g => {
      await this.status(g); // preflight just before writing, not a cached UI assertion
      if (!this.valid(g) || benchBlockReason(this.state, this.now())) return;
      this.possibleMotion = true;
      this.patch({ stationary: false, estimatedUntil: this.now() + duration, testLabel: label, error: "", reply: "Sending test request…" });
      const text = await this.host.sendCommand(cmd);
      if (!this.valid(g)) return;
      assertBenchAck(cmd, text);
      this.patch({ estimatedUntil: this.now() + duration, reply: text.trim() });
    }, true);
  }
  setRate(rate: 300 | 600): Promise<void> {
    if (benchBlockReason(this.state, this.now()) || !this.state.capabilities?.dshot) return Promise.resolve();
    return this.run(async g => {
      await this.status(g);
      if (!this.valid(g) || benchBlockReason(this.state, this.now())) return;
      const cmd: CliCommand = `dshot ${rate}`;
      this.patch({ rate: null, error: "" });
      const text = await this.host.sendCommand(cmd);
      if (!this.valid(g)) return;
      assertBenchAck(cmd, text);
      const raw = await this.host.sendCommand("dshot");
      if (!this.valid(g)) return;
      const reported = parseDshot(raw);
      if (reported !== rate) throw new Error("DShot readback does not match the requested rate.");
      this.patch({ rate: reported, reply: text.trim() });
    }, true);
  }
  stop(): Promise<void> {
    this.generation++; // invalidates preflight/start still awaiting a status reply
    if (this.stopFlight) return this.stopFlight;
    if (!this.state.connected || this.host.getConnectionStatus() !== "connected") return Promise.resolve();
    const session = this.session;
    this.patch({ busy: true, actionPending: true, stopping: true, stationary: false, pulsePercent: zeroSliders() });
    const previous = this.flight;
    const p = Promise.resolve(previous).then(async () => {
      if (session !== this.session || this.host.getConnectionStatus() !== "connected") return;
      const text = await this.host.sendCommand("motor_test 0");
      if (session !== this.session) return;
      assertBenchAck("motor_test 0", text);
      this.patch({ estimatedUntil: 0, reply: "Stop acknowledged by firmware. Check that motors have physically stopped.", error: "" });
    }).catch(e => {
      if (session === this.session) this.patch({ error: `Stop not confirmed: ${e instanceof Error ? e.message : String(e)}. Disconnect battery if motors keep spinning.` });
    }).finally(() => {
      if (this.stopFlight === p) { this.stopFlight = null; this.patch({ busy: false, actionPending: false, stopping: false }); }
    });
    this.stopFlight = p;
    return p;
  }
}
