/* SPDX-License-Identifier: Apache-2.0 */
/**
 * CRSF LINK_STATISTICS fixtures for the `receiver` report (rx_link_stats,
 * rx_link_lq, rx_loss_reason). "default" is the honest demo board: no UART,
 * no radio, absent stats. Every other scenario is a test fixture that models
 * one firmware state; "unknown-token" carries future/invalid tokens and
 * "old-fc" omits the three keys (firmware before CRSF link statistics).
 * "rf-mode-low" is the CRSF 4 fps mode (rf_profile 0) treated as link loss:
 * LQ is still reported, the gate is closed and failsafe is active.
 */
export const RECEIVER_LINK_SCENARIOS = ["default", "present-ok", "absent", "lq-zero", "rf-mode-low", "stats-stale", "no-frames", "unknown-token", "old-fc"] as const;
export type ReceiverLinkMockScenario = typeof RECEIVER_LINK_SCENARIOS[number];
interface LinkFixture { uart: string; link: string; age: string; frames: string; failsafe: string; lines: string[] }
const FIXTURES: Record<ReceiverLinkMockScenario, LinkFixture> = {
  "default": { uart: "0", link: "unbound", age: "-1", frames: "0", failsafe: "1", lines: ["rx_link_stats: absent", "rx_link_lq: unavailable", "rx_loss_reason: no-frames"] },
  "present-ok": { uart: "6", link: "live", age: "4", frames: "1834", failsafe: "0", lines: ["rx_link_stats: present", "rx_link_lq: 87", "rx_loss_reason: none"] },
  "absent": { uart: "6", link: "live", age: "4", frames: "1834", failsafe: "0", lines: ["rx_link_stats: absent", "rx_link_lq: unavailable", "rx_loss_reason: none"] },
  "lq-zero": { uart: "6", link: "lost", age: "612", frames: "1834", failsafe: "1", lines: ["rx_link_stats: present", "rx_link_lq: 0", "rx_loss_reason: lq-zero"] },
  "rf-mode-low": { uart: "6", link: "lost", age: "420", frames: "1834", failsafe: "1", lines: ["rx_link_stats: present", "rx_link_lq: 64", "rx_loss_reason: rf-mode-low"] },
  "stats-stale": { uart: "6", link: "lost", age: "380", frames: "1834", failsafe: "1", lines: ["rx_link_stats: present", "rx_link_lq: unavailable", "rx_loss_reason: stats-stale"] },
  "no-frames": { uart: "6", link: "lost", age: "2400", frames: "1834", failsafe: "1", lines: ["rx_link_stats: present", "rx_link_lq: unavailable", "rx_loss_reason: no-frames"] },
  "unknown-token": { uart: "6", link: "live", age: "4", frames: "1834", failsafe: "0", lines: ["rx_link_stats: partial", "rx_link_lq: 87%", "rx_loss_reason: rf-jammed"] },
  "old-fc": { uart: "0", link: "unbound", age: "-1", frames: "0", failsafe: "1", lines: [] },
};
/** No radio simulation by default: never invent live RC or successful UART binding. */
export class MockReceiver {
  private map="AETR";
  constructor(private scenario: ReceiverLinkMockScenario = "default") {}
  setScenario(scenario: ReceiverLinkMockScenario): void { this.scenario=scenario; }
  /** The FC state this scenario models: failsafe active (status `failsafe: ACTIVE`) whenever the report says `failsafe: 1`. */
  failsafeActive(): boolean { return FIXTURES[this.scenario].failsafe==="1"; }
  reset(): void { this.map="AETR"; }
  handle(line:string,armed:boolean,bench:boolean):string|null {
    if(line.startsWith("receiver_uart ")) return "receiver UART refused (no physical UART in mock)\r\n";
    if(line.startsWith("receiver_map ")) {
      if(armed||bench||!/^receiver_map (AETR|TAER)$/.test(line)) return "receiver map refused\r\n";
      this.map=line.slice(13);
    } else if(line!=="receiver") return null;
    const fx=FIXTURES[this.scenario];
    return ["receiver_api: 1","protocol: CRSF",`uart: ${fx.uart}`,`map: ${this.map}`,`link: ${fx.link}`,
      `age_ms: ${fx.age}`,`frames: ${fx.frames}`,"crc_errors: 0","stream_resets: 0",`armed: ${Number(armed)}`,
      `bench_active: ${Number(bench)}`,`failsafe: ${fx.failsafe}`,`channels: ${Array(16).fill("0.000").join(" ")}`,
      "persistence: ram",...fx.lines,"receiver_end: 1",""].join("\r\n");
  }
}
