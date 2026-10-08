/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import { catalog } from '../targets/catalog';
export function customProfileProblem(custom: boolean,mcu: string,flash: string,hse: string): string|null {
  if(!custom)return null;
  if(!mcu||!flash||!hse)return "Confirm the custom board's MCU, flash density and external crystal frequency.";
  if(mcu!=='STM32F405')return `A basic USB-only image is not implemented here for ${mcu}. No MCU fallback will be used.`;
  if(flash!=='1024'||hse!=='8000000')return 'The available basic image requires STM32F405xG, 1024 KiB flash and an 8 MHz external crystal. Other combinations need a matching build.';
  return null;
}
interface Props {
  custom:boolean; mcu:string; flash:string; hse:string; confirmed:boolean; disabled:boolean;
  onMcu:(v:string)=>void;onFlash:(v:string)=>void;onHse:(v:string)=>void;onConfirm:(v:boolean)=>void;
}
export function DiagnosticProfileControls(p:Props) {
  const problem=customProfileProblem(p.custom,p.mcu,p.flash,p.hse);
  return <div className="banner-warn" style={{marginTop:'0.5rem'}}>
    <strong>Experimental USB-only profile, not normal flight firmware.</strong>
    {p.custom&&<>
      <p>Basic defaults leave motors, sensors, receiver, UARTs and settings storage unassigned. These fields check a prebuilt image; they do not rewrite it.</p>
      <label htmlFor="custom-mcu">Physical MCU</label>
      <select id="custom-mcu" value={p.mcu} disabled={p.disabled} onChange={e=>{p.onMcu(e.target.value);p.onConfirm(false);}}>
        <option value="">Select the actual MCU</option>{catalog.mcus.map(m=><option key={m.id} value={m.part}>{m.part} ({m.family})</option>)}<option value="other">Other / not identified</option>
      </select>
      <label htmlFor="custom-flash">Physical flash density</label>
      <select id="custom-flash" value={p.flash} disabled={p.disabled} onChange={e=>{p.onFlash(e.target.value);p.onConfirm(false);}}>
        <option value="">Select flash density</option>{['256','512','1024','2048'].map(n=><option key={n} value={n}>{n} KiB</option>)}<option value="other">Other / unknown</option>
      </select>
      <label htmlFor="custom-hse">External crystal (HSE)</label>
      <select id="custom-hse" value={p.hse} disabled={p.disabled} onChange={e=>{p.onHse(e.target.value);p.onConfirm(false);}}>
        <option value="">Confirm crystal frequency</option>{[8,12,16,25].map(n=><option key={n} value={String(n*1000000)}>{n} MHz</option>)}<option value="other">Other / unknown</option>
      </select>
      {problem&&<p role="status">{problem}</p>}
    </>}
    <p>STM32F405xG, 1 MiB flash, 8 MHz HSE, 3.3 V. USB on PA11/PA12; PA9 unchanged. No motors, sensors, configuration writes or software bootloader command. Use USB power only with no attached peripherals. Motolab values are reference assumptions, not automatic board detection.</p>
    <label><input id="diagnostic-assumptions" type="checkbox" checked={p.confirmed} disabled={p.disabled||!!problem} onChange={e=>p.onConfirm(e.target.checked)}/> I confirm these MCU/flash/crystal/USB-routing assumptions match my board and independent BOOT recovery works.</label>
    <p>The flasher checks embedded diagnostic identity and the DFU flash layout before erase. Layout is not exact chip identity. Your existing MLTEMPF4 diagnostic HEX can be used; no firmware rebuild is needed.</p>
  </div>;
}
