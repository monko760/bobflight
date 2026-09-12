/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Smoke: MockSerial -> version -> status -> help; assert connect does not arm.
 */

import {
  BobFlightCliClient,
  MockTransportFactory,
  MOCK_PORT_PATH,
  parseVersionLine,
} from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function waitBanner(
  client: BobFlightCliClient,
  timeoutMs = 1000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error("banner timeout"));
    }, timeoutMs);
    const off = client.onLine((line) => {
      if (line.includes("ready") && line.startsWith("BobFlight")) {
        clearTimeout(t);
        off();
        resolve(line);
      }
    });
  });
}

async function main(): Promise<void> {
  console.log("=== BobFlight protocol smoke (MockSerial) ===");

  const factory = new MockTransportFactory();
  const client = new BobFlightCliClient(factory);

  const ports = await client.enumeratePorts();
  console.log("enumeratePorts:", ports.map((p) => p.path).join(", "));
  assert(
    ports.some((p) => p.path === MOCK_PORT_PATH),
    "mock port listed"
  );

  const statuses: string[] = [];
  const offStatus = client.onStatus((s) => statuses.push(s));

  // Register banner listener BEFORE connect — MockSerial emits the connect
  // banner in a microtask during open, so a post-connect waitBanner misses it.
  const bannerPromise = waitBanner(client);
  await client.connect({ path: MOCK_PORT_PATH, baudRate: 115200 });
  assert(client.getConnectionStatus() === "connected", "status connected");

  assert(
    client.getSentCommands().length === 0,
    `connect must not send commands; got ${client.getSentCommands().join(",")}`
  );
  assert(
    !client.getSentCommands().includes("arm"),
    "connect must not auto-arm"
  );
  console.log("OK: connect sent no commands (no auto-arm)");

  const banner = await bannerPromise;
  console.log("banner:", JSON.stringify(banner));
  assert(
    banner === "BobFlight 0.1.0-skeleton ready",
    `banner exact match, got ${JSON.stringify(banner)}`
  );

  const versionRaw = await client.sendCommand("version");
  const version = parseVersionLine(versionRaw);
  console.log("version raw:", JSON.stringify(versionRaw.trim()));
  console.log("version parsed:", version);
  assert(version === "BobFlight 0.1.0-skeleton", "version string");

  const versionHelper = await client.getVersion();
  assert(versionHelper === "BobFlight 0.1.0-skeleton", "getVersion()");

  const status = await client.getStatus();
  console.log("status.board:", status.board);
  console.log("status.gyro_ok:", status.gyro_ok);
  console.log("status.arm:", status.arm);
  console.log("status.failsafe:", status.failsafe);
  console.log("status.mmio:", status.mmio);
  console.log("failClosed:", status.failClosed, status.failClosedReasons);

  assert(status.board === "mock-board", "board");
  assert(status.gyro_ok === "no", "gyro_ok fail-closed default");
  assert(status.arm === "disarmed", "arm disarmed after connect");
  assert(status.failsafe === "ok", "failsafe");
  assert(status.mmio === "denied", "mmio denied");
  assert(status.failClosed === true, "failClosed true (gyro gate)");
  assert(
    status.failClosedReasons.includes("gyro_ok:no"),
    "reason gyro_ok:no"
  );
  assert(
    !status.failClosedReasons.includes("arm:disarmed"),
    "arm:disarmed is NOT an Arm fail-closed gate"
  );
  assert(
    !status.failClosedReasons.includes("mmio:denied"),
    "mmio:denied is informational, not Arm gate"
  );

  const help = await client.sendCommand("help");
  console.log("help starts with:", help.split(/\r?\n/)[0]);
  assert(help.startsWith("BobFlight CLI"), "help header");
  assert(help.includes("version"), "help lists version");
  assert(help.includes("status"), "help lists status");

  assert(
    !client.getSentCommands().includes("arm"),
    "smoke path must not send arm before explicit arm()"
  );
  console.log("sentCommands (pre-arm):", client.getSentCommands().join(", "));
  assert(
    client.getSentCommands().join(",") === "version,version,status,help",
    "expected version,version,status,help"
  );

  const armResp = await client.arm();
  console.log("arm (explicit API):", JSON.stringify(armResp.trim()));
  assert(
    armResp.includes("arm refused (gyro unhealthy or failsafe)"),
    "arm refuse string"
  );

  await client.disconnect();
  offStatus();
  assert(client.getConnectionStatus() === "disconnected", "disconnected");

  console.log("statuses seen:", statuses.join(" -> "));
  console.log("=== SMOKE PASS ===");
}

main().catch((err) => {
  console.error("=== SMOKE FAIL ===");
  console.error(err);
  process.exit(1);
});
