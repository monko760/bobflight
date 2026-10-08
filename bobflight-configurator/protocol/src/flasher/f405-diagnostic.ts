/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import type { ParsedHex } from './intel-hex';
export const F405_USB_DIAGNOSTIC_PROFILE = {
  id: 'f405-usb-diagnostic', mcu: 'F405', flashKiB: 1024, hseHz: 8000000,
  vddMv: 3300, usbPins: ['PA11','PA12'], power: 'usb-only',
  applicationEnd: 0x080c0000, stack: 0x20020000,
  motor: null, sensor: null, receiver: null, uart: null, settingsStorage: null,
} as const;
export const F405_DIAGNOSTIC_MARKERS = [
  'BobFlight F405 USB diagnostic, MLTEMPF4 reference\r\nExperimental; not normal firmware or flight-qualified.\r\n',
  'USB-only; PA9 unchanged; no motor or flash-programming drivers.\r\n',
] as const;
function contains(data: Uint8Array, text: string): boolean {
  outer: for(let i=0;i+text.length<data.length;i++) {
    if(data[i+text.length]!==0)continue;
    for(let j=0;j<text.length;j++)if(data[i+j]!==text.charCodeAt(j))continue outer;
    return true;
  }
  return false;
}
/** Content identity for accidental-file checks, not cryptographic authenticity. */
export function hasF405DiagnosticMarkers(image: ParsedHex): boolean {
  return F405_DIAGNOSTIC_MARKERS.every(text=>image.regions.some(r=>contains(r.data,text)));
}
export function validateF405DiagnosticImage(image: ParsedHex): void {
  const base=0x08000000, end=F405_USB_DIAGNOSTIC_PROFILE.applicationEnd;
  if(image.mcu!==undefined && image.mcu!=='F405')throw new Error('Diagnostic firmware MCU tag must match F405.');
  if(image.baseAddress!==base || !(image.bytes instanceof Uint8Array) || image.bytes.length<392 || image.bytes.length>end-base || !image.regions.length)throw new Error('F405 diagnostic requires a complete application vector table at 0x08000000.');
  const regions=[...image.regions].sort((a,b)=>a.address-b.address);let previous=base;
  for(const r of regions) {
    const limit=r.address+r.data.length;
    if(!Number.isSafeInteger(r.address)||!Number.isSafeInteger(limit)||!r.data.length||r.address<previous||limit>end||limit>base+image.bytes.length)throw new Error('F405 diagnostic range overlaps another region or reserved settings.');
    for(let i=0;i<r.data.length;i++)if(image.bytes[r.address-base+i]!==r.data[i])throw new Error('F405 diagnostic bytes and programmed regions disagree.');
    previous=limit;
  }
  const mapped=(a:number)=>regions.some(r=>a>=r.address&&a<r.address+r.data.length);
  for(let i=0;i<392;i++)if(!mapped(base+i))throw new Error('F405 diagnostic vector table contains missing bytes.');
  const v=new DataView(image.bytes.buffer,image.bytes.byteOffset,image.bytes.byteLength);
  if(v.getUint32(0,true)!==F405_USB_DIAGNOSTIC_PROFILE.stack)throw new Error('F405 diagnostic stack must match 128 KiB main SRAM.');
  for(const offset of [4,15*4,(16+67)*4]) {
    const address=v.getUint32(offset,true);
    if(!(address&1)||!mapped((address&~1)>>>0))throw new Error('F405 diagnostic reset/time/USB vectors must point to mapped Thumb code.');
  }
  if(image.entryAddress!==undefined&&(!Number.isSafeInteger(image.entryAddress)||!mapped((image.entryAddress&~1)>>>0)))throw new Error('F405 diagnostic entry is outside application data.');
  if(!hasF405DiagnosticMarkers(image))throw new Error('Missing embedded F405 USB diagnostic identity; a filename is not proof.');
}
/** AN3156 DfuSe internal-flash descriptor. Geometry is not exact chip identity. */
export function assertF405DfuLayout(name: string | null | undefined): void {
  const match=/^\s*@Internal Flash\s*\/\s*0x08000000\s*\/\s*([^/]+)\s*$/i.exec(name??'');
  if(!match)throw new Error('Cannot verify F405xG DFU internal-flash layout. No erase/program issued.');
  const actual:number[]=[];
  for(const group of match[1].split(',')) {
    const part=/^\s*(\d{1,3})\s*\*\s*(\d{1,4})\s*K\s*g\s*$/i.exec(group);
    if(!part)throw new Error('Unsupported F405 DFU layout descriptor. No erase/program issued.');
    const count=Number(part[1]),size=Number(part[2]);
    if(!count||count>12||!size||actual.length+count>12)throw new Error('Invalid F405 DFU sector count.');
    for(let i=0;i<count;i++)actual.push(size);
  }
  if(actual.join(',')!=='16,16,16,16,64,128,128,128,128,128,128,128')throw new Error('DFU geometry is not the selected 1 MiB F405xG layout. No erase/program issued.');
}
