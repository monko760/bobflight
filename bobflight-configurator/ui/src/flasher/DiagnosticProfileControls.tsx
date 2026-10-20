/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import { catalog, diagnosticProfiles } from '../targets/catalog';
type CustomLimits = { mcu: string; flash_kib: number; hse_hz: number };
const catalogCustom = diagnosticProfiles.find(p => p.custom)?.custom ?? null;
/** Limits come from the custom profile's boards/<id>.yaml (configurator.custom). */
export function customProfileProblem(custom: boolean,mcu: string,flash: string,hse: string,limits: CustomLimits|null = catalogCustom): string|null {
  if(!custom)return null;
  if(!mcu||!flash||!hse)return "Confirm the custom board's MCU, flash density and external crystal frequency.";
  if(!limits||mcu!==limits.mcu)return `A basic USB-only image is not implemented here for ${mcu}. No MCU fallback will be used.`;
  if(flash!==String(limits.flash_kib)||hse!==String(limits.hse_hz))return `The available basic image requires ${limits.mcu}xG, ${limits.flash_kib} KiB flash and an ${limits.hse_hz/1000000} MHz external crystal. Other combinations need a matching build.`;
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
      <p>Basic defaults leave motors, sensors, receiver, UARTs and settings storage unassigned. These fields select the supported basic build profile and validate imported images; they do not rewrite an imported HEX.</p>
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
    <p>The flasher checks embedded diagnostic identity and the DFU flash layout before erase. Layout is not exact chip identity. Build a matching diagnostic below or reuse an existing matching HEX. Other MCU/crystal combinations remain unavailable until their backends are implemented.</p>
  </div>;
}
