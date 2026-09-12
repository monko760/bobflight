/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Node smoke: Web Serial must report unavailable (no navigator.serial).
 */

import {
  isWebSerialAvailable,
  webSerialUnavailableReason,
} from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

console.log("=== BobFlight protocol smoke (Web Serial / Node) ===");
assert(
  isWebSerialAvailable() === false,
  "isWebSerialAvailable() must be false under Node"
);
const reason = webSerialUnavailableReason();
assert(reason !== null, "webSerialUnavailableReason() should be non-null under Node");
console.log("isWebSerialAvailable:", false);
console.log("reason:", reason);
console.log("PASS smoke-webserial-node");
