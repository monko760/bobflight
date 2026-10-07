/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { createHost, resolveConnectOptions, MOCK_PORT_PATH } from "../src/protocol/createHost";

async function runTests() {
  console.log("Running transport classification tests...");

  // 1. resolveConnectOptions normalization & mismatch tests
  console.log("Testing resolveConnectOptions normalization...");

  // Mock path normalization
  const normEmpty = resolveConnectOptions({});
  assert.equal(normEmpty.path, MOCK_PORT_PATH);
  assert.equal(normEmpty.transport, "mock");

  const normMockPath = resolveConnectOptions({ path: "mock://bobflight-sd" });
  assert.equal(normMockPath.path, "mock://bobflight-sd");
  assert.equal(normMockPath.transport, "mock");

  const normMockMatching = resolveConnectOptions({ path: MOCK_PORT_PATH, transport: "mock" });
  assert.equal(normMockMatching.path, MOCK_PORT_PATH);
  assert.equal(normMockMatching.transport, "mock");

  // WebSerial path normalization
  const normWebSerial = resolveConnectOptions({ path: "webserial:port-123" });
  assert.equal(normWebSerial.path, "webserial:port-123");
  assert.equal(normWebSerial.transport, "webserial");

  const normWebSerialMatching = resolveConnectOptions({ path: "webserial:port-123", transport: "webserial" });
  assert.equal(normWebSerialMatching.path, "webserial:port-123");
  assert.equal(normWebSerialMatching.transport, "webserial");

  // Serial path normalization
  const normSerial = resolveConnectOptions({ path: "/dev/ttyUSB0" });
  assert.equal(normSerial.path, "/dev/ttyUSB0");
  assert.equal(normSerial.transport, "serial");

  const normSerialMatching = resolveConnectOptions({ path: "/dev/ttyUSB0", transport: "serial" });
  assert.equal(normSerialMatching.path, "/dev/ttyUSB0");
  assert.equal(normSerialMatching.transport, "serial");

  // Mismatch & contradictory option tests
  console.log("Testing contradictory & mismatch rejection...");

  // Mock path with contradictory real hints
  assert.throws(
    () => resolveConnectOptions({ path: "mock://bobflight", transport: "webserial" }),
    /Contradictory or mismatched connect options/
  );
  assert.throws(
    () => resolveConnectOptions({ path: "mock://bobflight", transport: "serial" }),
    /Contradictory or mismatched connect options/
  );

  // WebSerial path with contradictory hints
  assert.throws(
    () => resolveConnectOptions({ path: "webserial:port-123", transport: "mock" }),
    /Contradictory or mismatched connect options/
  );
  assert.throws(
    () => resolveConnectOptions({ path: "webserial:port-123", transport: "serial" }),
    /Contradictory or mismatched connect options/
  );

  // Serial path with contradictory hints
  assert.throws(
    () => resolveConnectOptions({ path: "/dev/ttyUSB0", transport: "mock" }),
    /Contradictory or mismatched connect options/
  );
  assert.throws(
    () => resolveConnectOptions({ path: "/dev/ttyUSB0", transport: "webserial" }),
    /Contradictory or mismatched connect options/
  );

  // Empty path with explicit real transport (no fallback from explicit real request to mock)
  assert.throws(
    () => resolveConnectOptions({ transport: "webserial" }),
    /Contradictory or mismatched connect options/
  );
  assert.throws(
    () => resolveConnectOptions({ transport: "serial" }),
    /Contradictory or mismatched connect options/
  );

  // Unknown transport option
  assert.throws(
    () => resolveConnectOptions({ path: MOCK_PORT_PATH, transport: "invalid_transport" as never }),
    /Contradictory or mismatched connect options/
  );

  // 2. Real ProtocolHostAdapter integration tests
  console.log("Testing real ProtocolHostAdapter with mock transport...");

  const host = createHost("mock");

  // Attempt connection with contradictory hints
  await assert.rejects(
    async () => {
      await host.connect({ path: "mock://bobflight", transport: "webserial" });
    },
    /Contradictory or mismatched connect options/
  );
  assert.equal(host.isLiveConnection(), false, "Contradictory hints must never yield live connection");

  // Correct mock connect
  await host.connect({ path: MOCK_PORT_PATH, transport: "mock" });
  assert.equal(host.getConnectionStatus(), "connected", "Mock connection status connected");
  assert.equal(host.isLiveConnection(), false, "Mock connection is never live");

  // Disconnect clears classification
  await host.disconnect();
  assert.equal(host.getConnectionStatus(), "disconnected", "Connection status disconnected after disconnect");
  assert.equal(host.isLiveConnection(), false, "isLiveConnection is false after disconnect");

  console.log("PASS: All transport classification and regression tests succeeded.");
}

void runTests().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
