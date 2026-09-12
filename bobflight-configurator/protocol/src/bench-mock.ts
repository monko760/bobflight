/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** In-memory CLI simulation only. Never drives hardware. Default outputs unavailable. */
export class MockMotorBench {
  rate: 300 | 600 = 300;
  private until = 0;
  constructor(readonly ready = false, private now: () => number = Date.now) {}
  reset(): void { this.rate = 300; this.until = 0; }
  disconnect(): void { this.until = 0; }
  get help(): string { return "  motor_test <0..4> - 0 stop; one-second 8% props-off pulse\r\n  motor_pulse <1..4> <0..35> - one-second adjustable props-off pulse\r\n  motor_seq - spin motors in order RR FR RL FL (1s each)\r\n  dshot [300|600] - show or switch DShot bit rate\r\n"; }
  handle(line: string, armed: boolean): string | null {
    if (line === "dshot") return `dshot: ${this.rate} kbps\r\n`;
    if (line.startsWith("dshot ")) {
      if (!/^dshot (300|600)$/.test(line) || armed || this.now() < this.until)
        return "dshot speed refused (300 or 600, disarmed, bench stopped only)\r\n";
      this.rate = Number(line.slice(6)) as 300 | 600;
      return `dshot: switched to ${this.rate} kbps\r\n`;
    }
    if (line === "motor_seq") {
      if (armed || !this.ready) return "motor_seq refused (disarmed, USB CDC and healthy DShot required)\r\n";
      this.until = this.now() + 6800;
      return "sequence running: RR FR RL FL, 1s each - watch spin direction\r\n";
    }
    if (line.startsWith("motor_pulse ")) {
      const match = /^motor_pulse [1-4] ([0-9]|[12][0-9]|3[0-5])$/.exec(line);
      if (!match) return "motor pulse refused\r\n";
      const percent = Number(match[1]);
      if (percent !== 0 && (armed || !this.ready)) return "motor pulse refused\r\n";
      this.until = percent === 0 ? 0 : this.now() + 1000;
      return "motor pulse accepted (one second maximum)\r\n";
    }
    if (line.startsWith("motor_test ")) {
      if (!/^motor_test [0-4]$/.test(line)) return "motor test refused\r\n";
      const motor = Number(line.slice(11));
      if (motor !== 0 && (armed || !this.ready)) return "motor test refused\r\n";
      this.until = motor === 0 ? 0 : this.now() + 1000;
      return "motor test accepted (one second maximum)\r\n";
    }
    return null;
  }
}
