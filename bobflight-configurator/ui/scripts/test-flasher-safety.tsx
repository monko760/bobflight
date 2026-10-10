/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, type FakeElement } from "./fixtures/fakeDom";
import { scenario } from "./fixtures/flasherBackendStub";
import { FlasherPage } from "../src/pages/FlasherPage";
import { validateFirmwareForBoard } from "../src/flasher/firmwareValidation";
import { parseIntelHex } from "../src/flasher/intelHex";

const { container } = installFakeDom();
const usbEvents = new EventTarget();
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{usb:usbEvents}});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// ---- DOM Helpers ----
const isEl = (n: unknown): n is FakeElement => !!n && (n as FakeElement).nodeType === 1;
function isHidden(e: FakeElement): boolean {
  return e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || e.style.display === "none" || e.style.visibility === "hidden";
}
function visibleText(n: FakeElement): string {
  if (isHidden(n)) return "";
  return n.childNodes.map((c) => (isEl(c) ? visibleText(c) : c.textContent)).join("");
}
const byTag = (tag: string) => container.findAll((e) => e.tagName === tag);
function inputById(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "INPUT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `input #${id}`);
  return el;
}
function selectById(id: string): FakeElement {
  const el = container.findAll((e) => e.tagName === "SELECT" && e.getAttribute("id") === id)[0];
  assert.ok(el, `select #${id}`);
  return el;
}
function buttonByText(text: string): FakeElement {
  const b = byTag("BUTTON").find((e) => visibleText(e).startsWith(text));
  assert.ok(b, `button ${text}`);
  return b;
}
const isDisabled = (e: FakeElement) => e.disabled || e.hasAttribute("disabled");

function reactProps(e: FakeElement): Record<string, (ev: unknown) => void> {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "React props on the node");
  return (e as unknown as Record<string, Record<string, (ev: unknown) => void>>)[k];
}
async function check(el: FakeElement, checked: boolean) {
  flushSync(() => reactProps(el).onChange({ target: { checked }, currentTarget: { checked } }));
  await sleep(10);
}
async function selectOption(el: FakeElement, value: string) {
  flushSync(() => reactProps(el).onChange({ target: { value }, currentTarget: { value } }));
  await sleep(10);
}
async function click(el: FakeElement) {
  flushSync(() => reactProps(el).onClick({}));
  await sleep(10);
}

// Sample valid F722 hex string (small 16-byte record)
function record(bytes: number[]) { return ':'+[...bytes,(-bytes.reduce((a,b)=>a+b,0))&255].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase(); }
const F722_HEX = [record([2,0,0,4,8,0]),record([16,0,0,0,0,0,1,32,9,0,0,8,1,2,3,4,5,6,7,8]),record([0,0,0,1])].join('\n');


let gate=false; let busy=false;
function deferred<T>() { let resolve!: (v:T)=>void;let reject!: (e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; }
function mount() {
  (globalThis as any).__setupTestHost={connectionStatus:'disconnected',postFlashGate:gate,
    setPostFlashGate:(v:boolean)=>{gate=v},clearPostFlashGateAfterReconnect:async()=>false};
  const root=createRoot(container as never);flushSync(()=>root.render(<FlasherPage onBusyChange={v=>{busy=v}}/>));return root;
}
async function load(name='bobflight.hex',text=async()=>F722_HEX,size=F722_HEX.length) {
  flushSync(()=>reactProps(inputById('hex-file')).onChange({target:{files:[{name,size,text}]}}));await sleep(20);
}
async function prepare() {
  await check(inputById('props-off'),true);await check(inputById('backup-taken'),true);
  await selectOption(selectById('board'),'tmotor_f7_v2');await load();
}
{
  scenario.available=false;scenario.kinds=[];const root=mount();await sleep(20);
  assert(!inputById('use-mock-flash').checked);assert.deepEqual(scenario.kinds,['webusb-dfu']);
  assert(visibleText(container).includes('Live DFU unavailable'));flushSync(()=>root.unmount());
  console.log('PASS unavailable USB never opts into demo');
}
{
  scenario.available=true;const root=mount();await prepare();
  const old=deferred<string>();await load('old.hex',()=>old.promise);
  await load('bobflight-tmotor_f7_v2-main.hex');old.resolve('invalid old content');await sleep(30);
  assert(visibleText(container).includes('bobflight-tmotor_f7_v2-main.hex'));
  assert(!visibleText(container).includes('expected record')); // stale parse must not overwrite current file
  let read=false;await load('huge.hex',async()=>{read=true;return F722_HEX},9*1024*1024);
  assert(!read);assert(visibleText(container).includes('8 MiB'));assert(isDisabled(buttonByText('Flash')));
  flushSync(()=>root.unmount());console.log('PASS stale file reads and oversized file refused before reading');
}
{
  const root=mount();await prepare();const picker=deferred<any>();scenario.picks=0;scenario.pick=()=>picker.promise;
  const clickPicker=reactProps(buttonByText('Select DFU device')).onClick;
  flushSync(()=>{clickPicker({});clickPicker({})});assert.equal(scenario.picks,1);
  assert(isDisabled(inputById('use-mock-flash')));
  picker.resolve({vendorId:0x0483,productId:0xdf11});await sleep(30);
  await check(inputById('board-match-confirmed'),true);assert(!isDisabled(buttonByText('Flash')));
  await load('bobflight.hex'); assert(!inputById('board-match-confirmed').checked, 'same filename replacement must invalidate acknowledgement');
  await check(inputById('board-match-confirmed'),true);
  flushSync(()=>usbEvents.dispatchEvent(new Event('disconnect')));await sleep(20);
  assert(isDisabled(buttonByText('Flash')),'USB detach must invalidate selection');
  // Changing the target invalidates the physical board/image acknowledgement.
  await selectOption(selectById('board'),'');assert(!inputById('board-match-confirmed').checked);
  assert(isDisabled(buttonByText('Flash')));flushSync(()=>root.unmount());
  console.log('PASS picker reentry blocked and target change invalidates confirmation');
}
{
  gate=false;const root=mount();await prepare();scenario.pick=async()=>({vendorId:0x0483,productId:0xdf11});
  await click(buttonByText('Select DFU device'));await check(inputById('board-match-confirmed'),true);
  assert(!isDisabled(buttonByText('Flash')));const operation=deferred<void>();scenario.flash=()=>operation.promise;scenario.flashes=0;
  const start=reactProps(buttonByText('Flash')).onClick;flushSync(()=>{start({});start({})});
  assert.equal(scenario.flashes,1);assert(gate);assert(busy);
  const cancels=scenario.cancels;flushSync(()=>reactProps(buttonByText('Cancel')).onClick({}));
  assert.equal(scenario.cancels,cancels+1);assert(busy);assert(isDisabled(buttonByText('Flashing')));
  operation.reject(new Error('Flash cancelled'));assert(await waitFor(()=>!busy));
  assert(gate,'failed/cancelled flash must retain recovery gate');assert(isDisabled(buttonByText('Flash')),'retry requires a new device selection');
  flushSync(()=>root.unmount());console.log('PASS double start blocked, cancel waits for settlement, failed flash remains gated');
}

// Full erase is an independent destructive choice, never implied by normal flash.
{
  gate=false;scenario.available=true;scenario.flash=async()=>{};scenario.flashes=0;scenario.lastOptions=null;
  scenario.pick=async()=>({vendorId:0x0483,productId:0xdf11,productName:'same device'});
  const root=mount();await prepare();
  assert(!inputById('full-chip-erase').checked,'full erase starts OFF');
  await click(buttonByText('Select DFU device'));await check(inputById('board-match-confirmed'),true);
  await check(inputById('full-chip-erase'),true);
  assert(visibleText(container).includes('All firmware and saved settings will be erased'));
  assert(visibleText(container).includes('OTP memory, option bytes, or external memory'));
  assert(isDisabled(buttonByText('Flash')),'second destructive acknowledgement required');
  await click(buttonByText('Flash'));assert.equal(scenario.flashes,0,'imperative handler rejects missing erase consent');
  await check(inputById('full-erase-confirmed'),true);assert(!isDisabled(buttonByText('Flash')));
  await load('bobflight.hex');assert(!inputById('full-erase-confirmed').checked,'same-name replacement resets erase consent');
  await check(inputById('board-match-confirmed'),true);await check(inputById('full-erase-confirmed'),true);
  await click(buttonByText('Select DFU device'));assert(!inputById('full-erase-confirmed').checked,'even same device selection resets consent');
  await check(inputById('board-match-confirmed'),true);await check(inputById('full-erase-confirmed'),true);
  await check(inputById('full-chip-erase'),false);await check(inputById('full-chip-erase'),true);
  assert(!inputById('full-erase-confirmed').checked,'toggling full erase does not reuse acknowledgement');
  await check(inputById('full-erase-confirmed'),true);
  const operation=deferred<void>();scenario.flash=()=>operation.promise;
  await click(buttonByText('Flash'));assert.equal(scenario.flashes,1);
  assert.deepEqual(scenario.lastOptions,{expectedMcu:'F722',verify:true,leave:true,eraseMode:'full-chip'});
  assert(isDisabled(inputById('full-chip-erase')) && isDisabled(inputById('full-erase-confirmed')),'choice frozen during erase/flash');
  operation.resolve();assert(await waitFor(()=>!busy));
  assert(!inputById('full-erase-confirmed').checked,'success consumes erase consent');assert(gate,'post-flash recovery checks still required');
  await click(buttonByText('Select DFU device'));await check(inputById('board-match-confirmed'),true);await check(inputById('full-erase-confirmed'),true);
  scenario.flash=async()=>{throw new Error('test erase failure');};await click(buttonByText('Flash'));assert(await waitFor(()=>!busy));
  assert(!inputById('full-erase-confirmed').checked,'failure consumes erase consent');assert(gate);
  await click(buttonByText('Select DFU device'));await check(inputById('full-erase-confirmed'),true);
  flushSync(()=>usbEvents.dispatchEvent(new Event('disconnect')));await sleep(20);
  assert(!inputById('full-erase-confirmed').checked,'USB disconnect resets erase consent');
  await check(inputById('full-erase-confirmed'),true);await selectOption(selectById('board'),'matek_f722_px');
  assert(!inputById('full-erase-confirmed').checked,'board change resets erase consent');
  flushSync(()=>root.unmount());
  console.log('PASS full erase live UI: off by default, independent consent, handler backstop, image/device/target/toggle/session resets, frozen choice, exact verified options, success/failure recovery gates');
}
{
  scenario.flash=async()=>{};scenario.flashes=0;gate=false;const root=mount();await prepare();
  await check(inputById('full-chip-erase'),true);await check(inputById('full-erase-confirmed'),true);
  await check(inputById('use-mock-flash'),true);await sleep(20);
  assert(!inputById('full-erase-confirmed').checked,'switch to demo resets destructive acknowledgement');
  await check(inputById('mock-understood'),true);
  assert(isDisabled(buttonByText('Flash')));await click(buttonByText('Flash'));assert.equal(scenario.flashes,0);
  await check(inputById('full-erase-confirmed'),true);await click(buttonByText('Flash'));assert(await waitFor(()=>!busy));
  assert.equal(scenario.lastOptions.eraseMode,'full-chip');assert.equal(scenario.kinds.at(-1),'mock');assert(!gate,'demo never sets physical recovery gate');
  assert(visibleText(container).includes('no USB') || visibleText(container).includes('MOCK'));
  assert(!inputById('full-erase-confirmed').checked);flushSync(()=>root.unmount());
  console.log('PASS full erase demo: explicit confirmation, mock backend only, no hardware completion claim');
}

// F405 profile journey uses a synthetic validation fixture, not executable firmware.
function f405Hex() {
  const data=new Uint8Array(1024);const v=new DataView(data.buffer);
  v.setUint32(0,0x20020000,true);v.setUint32(4,0x08000189,true);
  v.setUint32(15*4,0x08000189,true);v.setUint32((16+67)*4,0x08000189,true);
  const strings="BobFlight F405 USB diagnostic, MLTEMPF4 reference\r\nExperimental; not normal firmware or flight-qualified.\r\n\0USB-only; PA9 unchanged; no motor or flash-programming drivers.\r\n\0";
  data.set(new TextEncoder().encode(strings),512);
  const lines=[record([2,0,0,4,8,0])];
  for(let i=0;i<data.length;i+=16)lines.push(record([16,i>>8,i&255,0,...data.slice(i,i+16)]));
  lines.push(record([0,0,0,1]));return lines.join('\n');
}
{
  scenario.available=true;scenario.flash=async()=>{};scenario.lastOptions=null;
  gate=false;const root=mount();await sleep(20);
  await selectOption(selectById('board'),'mltempf4');
  await check(inputById('props-off'),true);await check(inputById('backup-taken'),true);
  await load('bobflight-mltempf4-usb-diagnostic.hex',async()=>f405Hex());
  assert(isDisabled(buttonByText('Flash')),'diagnostic assumptions require explicit acknowledgement');
  await check(inputById('diagnostic-assumptions'),true);
  await click(buttonByText('Select DFU device'));
  await check(inputById('board-match-confirmed'),true);
  assert(!isDisabled(buttonByText('Flash')),'explicit diagnostic profile must accept matching test image');
  await click(buttonByText('Flash'));await sleep(30);
  assert.deepEqual(scenario.lastOptions,{expectedMcu:'F405',verify:true,leave:false,imageProfile:'f405-usb-diagnostic'});
  assert(gate,'normal configuration gate remains locked after diagnostic flash');
  assert(visibleText(container).includes('remove the BOOT bridge'));
  flushSync(()=>root.unmount());
  console.log('PASS F405 known-board journey: assumptions, exact profile, readback, no ROM jump, normal gate retained');
}
{
  const root=mount();await sleep(20);
  await selectOption(selectById('board'),'custom_f405xg_usb');
  assert(isDisabled(inputById('diagnostic-assumptions')));
  await selectOption(selectById('custom-mcu'),'STM32H743');
  await selectOption(selectById('custom-flash'),'1024');
  await selectOption(selectById('custom-hse'),'8000000');
  assert(visibleText(container).includes('not implemented here for STM32H743'));
  assert(isDisabled(inputById('diagnostic-assumptions')));
  await selectOption(selectById('custom-mcu'),'STM32F405');
  assert(!isDisabled(inputById('diagnostic-assumptions')));
  await check(inputById('diagnostic-assumptions'),true);
  await selectOption(selectById('custom-hse'),'25000000');
  assert(!inputById('diagnostic-assumptions').checked);
  assert(isDisabled(inputById('diagnostic-assumptions')));
  assert(isDisabled(buttonByText('Flash')));
  flushSync(()=>root.unmount());
  console.log('PASS custom-board selection: unknowns and unsupported MCU/clock blocked, changed assumptions invalidate acknowledgement');
}
