/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * N1 Modes tab rate-fallback readout: parsed `modes` snapshots (mock, legacy,
 * inactive, attitude fallback, failsafe gravity fallback) rendered statically.
 * The mock must never claim an estimator state it does not have.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelFallbackReadout, LEVEL_FALLBACK_LABELS } from "../src/components/LevelFallbackReadout";
import { parseModes } from "../../protocol/src/parse-modes";
import { MockPortsModes } from "../../protocol/src/ports-modes-mock";

let passed = 0;
function test(name: string, fn: () => void) { try { fn(); } catch (e) { console.log(`FAIL ${name}`); throw e; } passed++; console.log(`PASS ${name}`); }
const mock = new MockPortsModes().handle("modes", false, false)!;
const fw = mock.replace("source: mock\r\n", "");
function withFallback(active: 0 | 1, reason: string, count: number, state: string): string {
  return fw.replace("effective_mode: angle", `effective_mode: ${active ? "acro" : "angle"}`)
    .replace("mode_conflict: 0", `mode_conflict: 0\r\nlevel_fallback: ${active}\r\nlevel_fallback_reason: ${reason}\r\nlevel_fallback_count: ${count}\r\nattitude_state: ${state}`);
}
const html = (raw: string | null) => renderToStaticMarkup(<LevelFallbackReadout snapshot={raw === null ? null : parseModes(raw)} />);
const text = (h: string, attr: string) => { const m = new RegExp(`<[a-z]+ ${attr}="?[^>]*>(.*?)</`).exec(h); assert.ok(m, `${attr} in ${h}`); return m[1]; };

test("offline mock: not reported, no fake estimator state", () => {
  const h = html(mock);
  assert.match(h, /data-level-fallback="unreported"/);
  assert.equal(text(h, "data-level-fallback-text"), LEVEL_FALLBACK_LABELS.notReportedMock);
  assert.equal(text(h, "data-level-fallback-attitude"), "not reported");
  assert.doesNotMatch(h, /role="alert"/);
});
test("legacy firmware without the keys: not reported", () => {
  const h = html(fw);
  assert.equal(text(h, "data-level-fallback-text"), LEVEL_FALLBACK_LABELS.notReported);
  assert.equal(text(h, "data-level-fallback-count"), "not reported");
});
test("no snapshot: not reported", () => { assert.match(html(null), /data-level-fallback="unreported"/); });
test("inactive: verbatim count and attitude state, no alert", () => {
  const h = html(withFallback(0, "none", 2, "valid"));
  assert.match(h, /data-level-fallback="inactive"/);
  assert.equal(text(h, "data-level-fallback-text"), LEVEL_FALLBACK_LABELS.inactive);
  assert.equal(text(h, "data-level-fallback-attitude"), "valid");
  assert.equal(text(h, "data-level-fallback-count"), "2");
  assert.doesNotMatch(h, /role="alert"/);
});
test("attitude-invalid fallback: alert, rate control explanation, recovering state", () => {
  const h = html(withFallback(1, "attitude-invalid", 1, "recovering"));
  assert.match(h, /data-level-fallback="active"/);
  assert.match(h, /role="alert"/);
  assert.equal(text(h, "data-level-fallback-text"), LEVEL_FALLBACK_LABELS.activeAttitude);
  assert.match(text(h, "data-level-fallback-attitude"), /^recovering/);
});
test("failsafe gravity fallback: alert with its own wording", () => {
  const h = html(withFallback(1, "failsafe-gravity-unqualified", 5, "valid"));
  assert.match(h, /role="alert"/);
  assert.equal(text(h, "data-level-fallback-text"), LEVEL_FALLBACK_LABELS.activeGravity);
  assert.equal(text(h, "data-level-fallback-count"), "5");
});
test("contradictory report is refused by the parser, never rendered", () => {
  assert.throws(() => parseModes(withFallback(1, "attitude-invalid", 1, "valid").replace("effective_mode: acro", "effective_mode: angle")));
});
console.log(`PASS level fallback readout: ${passed} checks`);
