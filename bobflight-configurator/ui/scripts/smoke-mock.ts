/**
 * UI host smoke via @bobflight/protocol BobFlightCliClient + MockTransportFactory.
 */
import {
  BobFlightCliClient,
  MOCK_PORT_PATH,
  MockTransportFactory,
  parseStatus,
  shouldDisableArm,
} from "../src/protocol/smokeExports";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main(): Promise<void> {
  console.log("=== BobFlight UI protocol-host smoke ===");
  const client = new BobFlightCliClient(new MockTransportFactory());

  const ports = await client.enumeratePorts();
  console.log("enumeratePorts:", ports.map((p) => p.path).join(", "));
  assert(ports.some((p) => p.path === MOCK_PORT_PATH), "mock port listed");

  await client.connect({
    path: MOCK_PORT_PATH,
    baudRate: 115200,
    transport: "mock",
  });
  assert(client.getConnectionStatus() === "connected", "status connected");
  assert(client.getSentCommands().length === 0, "no auto-arm / no cmds on connect");
  console.log("OK: connect (no auto-arm)");

  const version = await client.getVersion();
  console.log("version:", version);
  assert(version === "BobFlight 0.1.0-skeleton", "version string");

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
  assert(status.mmio === "denied", "mmio denied informational");
  assert(status.failClosed === true, "failClosed true");
  assert(status.failClosedReasons.includes("gyro_ok:no"), "reason gyro_ok:no");
  assert(
    !status.failClosedReasons.includes("mmio:denied"),
    "mmio:denied NOT an Arm gate",
  );
  assert(
    !status.failClosedReasons.includes("arm:disarmed"),
    "arm:disarmed NOT an Arm gate",
  );
  assert(shouldDisableArm(status) === true, "shouldDisableArm");

  // Local parseStatus re-export sanity
  const again = parseStatus(status.raw);
  assert(again.failClosedReasons.join(",") === status.failClosedReasons.join(","), "parse parity");

  const armResp = await client.sendCommand("arm");
  console.log("arm:", JSON.stringify(armResp.trim()));
  assert(
    armResp.includes("arm refused (gyro unhealthy or failsafe)"),
    "arm refuse",
  );

  await client.disconnect();
  assert(client.getConnectionStatus() === "disconnected", "disconnected");
  console.log("=== SMOKE PASS ===");
}

main().catch((err) => {
  console.error("=== SMOKE FAIL ===");
  console.error(err);
  process.exit(1);
});
