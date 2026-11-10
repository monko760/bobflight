/* SPDX-License-Identifier: Apache-2.0 */
/**
 * PID and Filters save honesty on the real host adapter: CommandGate, client
 * and MockSerial. Empty numeric input must stay blank (not 0), Save stays off
 * on a clean page, and a set that already went out is not reported as only
 * "set failed".
 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { PidPage } from "../src/pages/PidPage";
import { FiltersPage, LPF_RANGE_HINT } from "../src/pages/FiltersPage";
import { createHost } from "../src/protocol/createHost";
import type { BobFlightHost } from "../src/protocol/types";
import { STORAGE_SCOPE_V13, type BobFlightCliClient, type MockSerial } from "@bobflight/protocol";

const { container } = installFakeDom();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const pageText = () => visibleText(container);
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");
function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
function input(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `input #${id}; text: ${pageText().slice(0, 240)}`);
  return el;
}
function button(text: string): FakeElement {
  const b = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === text)[0];
  assert.ok(b, `button "${text}"; buttons: ${container.findAll((e) => e.tagName === "BUTTON").map((e) => visibleText(e).trim()).join(" | ")}`);
  return b;
}
function typeInto(id: string, value: string) {
  flushSync(() => reactProps(input(id)).onChange({ target: { value, checked: false } }));
}
function press(el: FakeElement) {
  flushSync(() => reactProps(el).onClick({}));
}
const saveError = (id: string) => {
  const el = container.findAll((e) => e.getAttribute("data-testid") === id)[0];
  return el ? visibleText(el) : "";
};
const HONEST = "Some values may already be applied in RAM or saved. Reload before retrying.";

type PageName = "pid" | "filters";
interface Rig {
  host: BobFlightHost;
  client: BobFlightCliClient;
  root: Root;
  ctx: { postFlashGate: boolean; connectionStatus: string };
  flags: { failSet: string; armed: boolean };
  done(): Promise<void>;
}

function storageReply(dirty: boolean, armed: boolean): string {
  return ["storage_api: 1", "backend: flash", "schema: 13", `state: ${dirty ? "dirty" : "saved"}`, `dirty: ${dirty ? 1 : 0}`, "generation: 2",
    "last_error: none", `scope: ${STORAGE_SCOPE_V13}`, `armed: ${armed ? 1 : 0}`, "bench_active: 0", "calibration_active: 0", "flight_enabled: 0", "accel_cal_saved: no", "storage_end: 1"]
    .map((l) => `${l}\r\n`).join("");
}

async function rig(): Promise<Rig> {
  const host = createHost("mock");
  await host.connect({ path: "mock://bobflight", baudRate: 115200, transport: "mock" });
  const client = (host as unknown as { getClient(): BobFlightCliClient }).getClient();
  const port = (client as unknown as { port: MockSerial }).port;
  let savedSnap = JSON.stringify(port.getSettingsSnapshot());
  const flags = { failSet: "", armed: false };
  const write = port.write.bind(port);
  (port as unknown as { write: (d: string | Buffer) => boolean }).write = (data) => {
    const line = String(data).trim();
    if (flags.failSet && line.startsWith(`set ${flags.failSet} `)) {
      setTimeout(() => port.emit("data", Buffer.from("set failed\r\n")), 1);
      return true;
    }
    if (line === "storage") {
      const dirty = JSON.stringify(port.getSettingsSnapshot()) !== savedSnap;
      setTimeout(() => port.emit("data", Buffer.from(storageReply(dirty, flags.armed))), 1);
      return true;
    }
    if (line === "save") {
      savedSnap = JSON.stringify(port.getSettingsSnapshot());
      setTimeout(() => port.emit("data", Buffer.from("saved: flash verified\r\n")), 1);
      return true;
    }
    return write(data);
  };
  const ctx = {
    host, connectionStatus: "connected", postFlashGate: false, version: "BobFlight test", status: null,
    refreshStatus: async () => {}, pollAfterConnect: async () => {}, setLastError: () => {},
  };
  (globalThis as Record<string, unknown>).__setupTestHost = ctx;
  const root = createRoot(container as never);
  return {
    host, client, root, flags, ctx,
    done: async () => { flushSync(() => root.unmount()); await host.disconnect(); },
  };
}

function render(r: Rig, page: PageName) {
  flushSync(() => r.root.render(page === "pid" ? <PidPage /> : <FiltersPage />));
}

async function quiet(r: Rig) {
  let n = r.client.getSentCommands().length;
  let still = Date.now();
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    await sleep(25);
    const k = r.client.getSentCommands().length;
    if (k !== n) { n = k; still = Date.now(); }
    else if (Date.now() - still >= 300) return;
  }
  assert.fail(`page never went quiet; last commands: ${r.client.getSentCommands().slice(-8).join(" | ")}`);
}

async function open(r: Rig, page: PageName) {
  render(r, page);
  const probe = page === "pid" ? "pid_roll_p" : "gyro_lpf_hz";
  const want = page === "pid" ? "0.002" : "320";
  assert.ok(await waitFor(() => {
    const defs = container.findAll((e) => e.tagName === "BUTTON" && visibleText(e).trim() === "Defaults…")[0];
    return !!defs && !isDisabled(defs) && input(probe).value === want;
  }, 12000), `${page} loaded; text: ${pageText().slice(0, 400)}`);
  await quiet(r);
}

function sets(r: Rig): string[] {
  return r.client.getSentCommands().filter((c) => c.startsWith("set "));
}

let passed = 0;
let failed = 0;
const only = process.env.ONLY;
async function test(name: string, fn: () => Promise<void>) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(e);
  }
}

async function main() {
  await test("PID: Save stays disabled on a clean page and enables only for a real edit", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      assert.ok(isDisabled(button("Save")), "clean page must not offer Save");
      const before = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, before, "clean Save sent nothing");
      typeInto("pid_roll_p", "0.009");
      assert.equal(input("pid_roll_p").value, "0.009");
      assert.ok(!isDisabled(button("Save")), "a real edit enables Save");
      typeInto("pid_roll_p", "0.002");
      assert.ok(isDisabled(button("Save")), "reverting to the loaded value disables Save");
    } finally { await r.done(); }
  });

  await test("PID: clearing a number is blank and invalid, not 0, and Save sends nothing", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      typeInto("pid_roll_p", "");
      typeInto("min_throttle", "");
      assert.equal(input("pid_roll_p").value, "", "empty P is blank");
      assert.notEqual(input("pid_roll_p").value, "0");
      assert.equal(input("min_throttle").value, "", "empty min throttle is blank");
      assert.equal(input("pid_roll_p").getAttribute("aria-invalid"), "true");
      assert.equal(input("min_throttle").getAttribute("aria-invalid"), "true");
      assert.match(pageText(), /Enter finite values within range/);
      assert.ok(isDisabled(button("Save")));
      const before = sets(r);
      press(button("Save"));
      await sleep(100);
      assert.deepEqual(sets(r), before, `empty save sent sets: ${sets(r).join(" | ")}`);
      assert.equal((await r.host.getSetting("pid_roll_p")).value, "0.002", "FC P was not written as 0");
      assert.equal((await r.host.getSetting("min_throttle")).value, "0.05");
    } finally { await r.done(); }
  });

  await test("PID: a typed 0 stays 0 and can be saved; 11 cannot", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      typeInto("pid_roll_p", "0");
      assert.equal(input("pid_roll_p").value, "0");
      assert.notEqual(input("pid_roll_p").getAttribute("aria-invalid"), "true");
      assert.ok(!isDisabled(button("Save")), "typed 0 is a legal unsaved change");
      typeInto("pid_roll_p", "11");
      assert.equal(input("pid_roll_p").value, "11");
      assert.equal(input("pid_roll_p").getAttribute("aria-invalid"), "true");
      assert.ok(isDisabled(button("Save")));
      const before = sets(r);
      press(button("Save"));
      await sleep(80);
      assert.deepEqual(sets(r), before, "out of range sent nothing");
    } finally { await r.done(); }
  });

  await test("PID: post-flash gate and armed storage keep Save off", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      typeInto("pid_roll_p", "0.009");
      assert.ok(!isDisabled(button("Save")), "control: Save is available before the gate");
      r.ctx.postFlashGate = true;
      render(r, "pid");
      assert.equal(input("pid_roll_p").value, "0.009", "the edit is still on screen");
      assert.ok(isDisabled(button("Save")), "post-flash gate blocks Save");
      const blocked = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, blocked, "post-flash Save sent nothing");
      r.ctx.postFlashGate = false;
      r.flags.armed = true;
      render(r, "pid");
      // Remount so the page reads the armed storage snapshot.
      flushSync(() => r.root.render(<div />));
      await open(r, "pid");
      typeInto("pid_roll_p", "0.009");
      assert.ok(isDisabled(button("Save")), "armed storage cannot be saved");
      const armedMark = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, armedMark, "armed Save sent nothing");
    } finally { await r.done(); }
  });

  await test("PID: a successful save is read back and then Save is off again", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      typeInto("pid_roll_p", "0.009");
      press(button("Save"));
      assert.ok(await waitFor(() => /Saved to controller flash and verified/.test(pageText()), 12000), `saved message: ${pageText().slice(-500)}`);
      await quiet(r);
      assert.equal(input("pid_roll_p").value, "0.009");
      assert.equal((await r.host.getSetting("pid_roll_p")).value, "0.009");
      assert.ok(isDisabled(button("Save")), "clean again after a verified save");
      assert.equal(saveError("pid-save-error"), "");
    } finally { await r.done(); }
  });

  await test("PID: mid-save set failure is not only 'set failed' and blocks retry until reload", async () => {
    const r = await rig();
    try {
      await open(r, "pid");
      typeInto("pid_roll_p", "0.009");
      r.flags.failSet = "pid_roll_i";
      const before = sets(r);
      press(button("Save"));
      assert.ok(await waitFor(() => saveError("pid-save-error").includes(HONEST), 8000), `error: ${saveError("pid-save-error") || pageText().slice(-400)}`);
      const err = saveError("pid-save-error").trim();
      assert.notEqual(err, "set failed");
      assert.ok(!/^set failed\.?$/.test(err), err);
      assert.ok(err.includes(HONEST), err);
      await quiet(r);
      const sentSets = sets(r).slice(before.length);
      assert.ok(sentSets.some((c) => c.startsWith("set pid_roll_p ")), `first set went out: ${sentSets.join(" | ")}`);
      assert.ok(sentSets.some((c) => c.startsWith("set pid_roll_i ")), `failed set went out: ${sentSets.join(" | ")}`);
      assert.equal((await r.host.getSetting("pid_roll_p")).value, "0.009", "the set that succeeded is in RAM");
      assert.equal((await r.host.getSetting("pid_roll_i")).value, "0.001", "the refused set was not applied");
      assert.ok(isDisabled(button("Save")), "Save stays off after a partial apply");
      const mark = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(150);
      assert.equal(r.client.getSentCommands().length, mark, "retry before reload sent nothing");
      r.flags.failSet = "";
      press(button("Read again"));
      await quiet(r);
      assert.equal(input("pid_roll_p").value, "0.009", `after reload: ${pageText().slice(-400)}`);
      assert.equal(saveError("pid-save-error"), "");
      assert.ok(isDisabled(button("Save")), "clean after reload");
      typeInto("pid_roll_i", "0.002");
      assert.ok(!isDisabled(button("Save")), "a new edit after reload can be saved");
    } finally { await r.done(); }
  });

  await test("Filters: Save stays disabled on a clean page and enables only for a real edit", async () => {
    const r = await rig();
    try {
      await open(r, "filters");
      assert.ok(isDisabled(button("Save")), "clean page must not offer Save");
      const before = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, before, "clean Save sent nothing");
      typeInto("gyro_lpf_hz", "100");
      assert.ok(!isDisabled(button("Save")), "a real edit enables Save");
      typeInto("gyro_lpf_hz", "320");
      assert.ok(isDisabled(button("Save")), "reverting to the loaded value disables Save");
    } finally { await r.done(); }
  });

  await test("Filters: clearing an LPF is blank and invalid, not 0, and Save sends nothing", async () => {
    const r = await rig();
    try {
      await open(r, "filters");
      typeInto("gyro_lpf_hz", "");
      typeInto("dterm_lpf_hz", "");
      assert.equal(input("gyro_lpf_hz").value, "");
      assert.notEqual(input("gyro_lpf_hz").value, "0");
      assert.equal(input("dterm_lpf_hz").value, "");
      assert.equal(input("gyro_lpf_hz").getAttribute("aria-invalid"), "true");
      assert.equal(input("dterm_lpf_hz").getAttribute("aria-invalid"), "true");
      assert.match(pageText(), /empty is not 0/);
      assert.ok(isDisabled(button("Save")));
      const before = sets(r);
      press(button("Save"));
      await sleep(100);
      assert.deepEqual(sets(r), before, `empty save sent sets: ${sets(r).join(" | ")}`);
      assert.equal((await r.host.getSetting("gyro_lpf_hz")).value, "320");
      assert.equal((await r.host.getSetting("dterm_lpf_hz")).value, "53");
    } finally { await r.done(); }
  });

  await test("Filters: out-of-range LPF is the client hint and sends nothing; typed 0 is saved", async () => {
    const r = await rig();
    try {
      await open(r, "filters");
      typeInto("gyro_lpf_hz", "5");
      assert.equal(input("gyro_lpf_hz").getAttribute("aria-invalid"), "true");
      assert.match(pageText(), new RegExp(`Gyro LPF \\(Hz\\): ${LPF_RANGE_HINT.replace(/[().]/g, "\\$&")}`));
      assert.ok(isDisabled(button("Save")));
      const before = sets(r);
      press(button("Save"));
      await sleep(80);
      assert.deepEqual(sets(r), before, "out of range sent nothing");
      typeInto("gyro_lpf_hz", "0");
      assert.equal(input("gyro_lpf_hz").value, "0", "typed 0 stays 0 (LPF off)");
      assert.notEqual(input("gyro_lpf_hz").getAttribute("aria-invalid"), "true");
      assert.ok(!isDisabled(button("Save")), "typed 0 is a legal unsaved change");
      press(button("Save"));
      assert.ok(await waitFor(() => /Last reply: saved/.test(pageText()), 15000), `saved: ${pageText().slice(-500)}`);
      await quiet(r);
      assert.equal((await r.host.getSetting("gyro_lpf_hz")).value, "0");
      assert.equal(input("gyro_lpf_hz").value, "0");
      assert.ok(isDisabled(button("Save")), "clean after saving 0");
    } finally { await r.done(); }
  });

  await test("Filters: post-flash gate and armed storage keep Save off", async () => {
    const r = await rig();
    try {
      await open(r, "filters");
      typeInto("gyro_lpf_hz", "100");
      assert.ok(!isDisabled(button("Save")), "control: Save is available before the gate");
      r.ctx.postFlashGate = true;
      render(r, "filters");
      assert.equal(input("gyro_lpf_hz").value, "100");
      assert.ok(isDisabled(button("Save")), "post-flash gate blocks Save");
      const blocked = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, blocked, "post-flash Save sent nothing");
      r.ctx.postFlashGate = false;
      r.flags.armed = true;
      flushSync(() => r.root.render(<div />));
      await open(r, "filters");
      typeInto("dterm_lpf_hz", "100");
      assert.ok(isDisabled(button("Save")), "armed storage cannot be saved");
      const armedMark = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(80);
      assert.equal(r.client.getSentCommands().length, armedMark, "armed Save sent nothing");
    } finally { await r.done(); }
  });

  await test("Filters: mid-save set failure is not only 'set failed' and blocks retry until reload", async () => {
    const r = await rig();
    try {
      await open(r, "filters");
      typeInto("gyro_lpf_hz", "100");
      r.flags.failSet = "dterm_lpf_hz";
      const before = sets(r);
      press(button("Save"));
      assert.ok(await waitFor(() => saveError("save-error").includes(HONEST), 8000), `error: ${saveError("save-error") || pageText().slice(-400)}`);
      const err = saveError("save-error").trim();
      assert.notEqual(err, "set failed");
      assert.ok(!/^set failed\.?$/.test(err), err);
      assert.ok(err.includes(HONEST), err);
      await quiet(r);
      const sentSets = sets(r).slice(before.length);
      assert.ok(sentSets.some((c) => c.startsWith("set gyro_lpf_hz ")), `first set went out: ${sentSets.join(" | ")}`);
      assert.ok(sentSets.some((c) => c.startsWith("set dterm_lpf_hz ")), `failed set went out: ${sentSets.join(" | ")}`);
      assert.equal((await r.host.getSetting("gyro_lpf_hz")).value, "100");
      assert.equal((await r.host.getSetting("dterm_lpf_hz")).value, "53");
      assert.ok(isDisabled(button("Save")));
      const mark = r.client.getSentCommands().length;
      press(button("Save"));
      await sleep(150);
      assert.equal(r.client.getSentCommands().length, mark, "retry before reload sent nothing");
      r.flags.failSet = "";
      press(button("Read again"));
      await quiet(r);
      assert.equal(input("gyro_lpf_hz").value, "100", `after reload: ${pageText().slice(-500)}`);
      assert.equal(saveError("save-error"), "");
      assert.ok(isDisabled(button("Save")), "clean after reload");
      typeInto("dterm_lpf_hz", "80");
      assert.ok(!isDisabled(button("Save")), "a new edit after reload can be saved");
    } finally { await r.done(); }
  });

  console.log(`pid-filters-honesty: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

const guard = setTimeout(() => { console.error("timeout"); process.exit(1); }, 120000);
main().then(() => clearTimeout(guard)).catch((e) => { clearTimeout(guard); console.error(e); process.exit(1); });
