/* SPDX-License-Identifier: Apache-2.0 */
/** No radio simulation: never invent live RC or successful UART binding. */
export class MockReceiver {
  private map="AETR";
  reset(): void { this.map="AETR"; }
  handle(line:string,armed:boolean,bench:boolean):string|null {
    if(line.startsWith("receiver_uart ")) return "receiver UART refused (no physical UART in mock)\r\n";
    if(line.startsWith("receiver_map ")) {
      if(armed||bench||!/^receiver_map (AETR|TAER)$/.test(line)) return "receiver map refused\r\n";
      this.map=line.slice(13);
    } else if(line!=="receiver") return null;
    return ["receiver_api: 1","protocol: CRSF","uart: 0",`map: ${this.map}`,"link: unbound",
      "age_ms: -1","frames: 0","crc_errors: 0","stream_resets: 0",`armed: ${Number(armed)}`,
      `bench_active: ${Number(bench)}`,"failsafe: 1",`channels: ${Array(16).fill("0.000").join(" ")}`,
      "persistence: ram","receiver_end: 1",""].join("\r\n");
  }
}
