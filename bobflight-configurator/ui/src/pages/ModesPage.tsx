import {StoragePanel} from "../components/StoragePanel";
import {ModeReceiver} from '../components/ModeReceiver';
/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useState} from 'react';
import {parseModes,modeRangeCommand,controlSourceCommand,canEditModeRanges,canSelectControlSource,type ModeRow} from '../protocol';
import {useConfigSnapshot} from './useConfigSnapshot';
const labels:Record<ModeRow['name'],string>={ARM:'ARM — preview only',ANGLE:'Angle',ACRO:'Acro',HORIZON:'Level (Horizon)'};
const descriptions:Record<ModeRow['name'],string>={
 ARM:'Range preview only. This does not assign the real arm switch or change arming behavior.',
 ANGLE:'Limited-tilt self-leveling. Sticks request a tilt angle; center returns toward level.',
 ACRO:'Sticks request rotation rates. No leveling in the setpoint generator.',
 HORIZON:'Self-level near centered roll/pitch sticks, blending toward rate control with greater deflection. No altitude hold.'
};
const modeLabel=(mode:string|undefined)=>mode==='horizon'?'Level (Horizon)':mode==='acro'?'Acro':mode==='angle'?'Angle':'Unavailable';
export function ModesPage(){
 const q=useConfigSnapshot('modes',parseModes),s=q.connected?q.snapshot:null;
 const [drafts,setDrafts]=useState<ModeRow[]|null>(null),[reply,setReply]=useState(''),[localError,setLocalError]=useState('');
 useEffect(()=>{if(!q.connected){setDrafts(null);setReply('');setLocalError('');}else if(s&&drafts===null)setDrafts(s.modes.map(m=>({...m})));},[s,q.connected,drafts]);
 const configuredArm=s?.armSemantics==='configured';
 const label=(name:ModeRow['name'])=>name==='ARM'&&configuredArm?'ARM — configured switch':labels[name];
 const editable=canEditModeRanges(s,q.connected,q.pending);
 const sourceEditable=canSelectControlSource(s,q.connected,q.pending);
 function edit(name:string,patch:Partial<ModeRow>){setReply('');setDrafts(old=>old?.map(m=>m.name===name?{...m,...patch}:m)??null);}
 async function apply(m:ModeRow){
  if(!editable)return;setLocalError('');setReply('');
  try{
   const cmd=modeRangeCommand(m);
   const result=await q.execute(cmd,v=>{
    const row=v.modes.find(r=>r.name===m.name);
    if(!row||['enabled','aux','minUs','maxUs'].some(k=>row[k as keyof ModeRow]!==m[k as keyof ModeRow]))throw Error('Mode readback does not match request');
   });
   if(result){setDrafts(old=>old?.map(x=>x.name===m.name?{...result.modes.find(r=>r.name===m.name)!}:x)??null);setReply(`${label(m.name)} applied and read back. Use Save to controller to retain it after power-off.`);}
  }catch(e){setLocalError(String(e));}
 }
 async function source(value:'manual'|'aux'){
  if(!sourceEditable)return;setReply('');setLocalError('');
  const result=await q.execute(controlSourceCommand(value),v=>{if(v.apiVersion!==2||v.controlSource!==value)throw Error('Control source readback does not match request');});
  if(result)setReply(`${value==='aux'?'AUX switches':'Manual source'} applied and read back. Use Save to controller to retain it after power-off.`);
 }
 async function refresh(){const result=await q.execute();if(result){setDrafts(result.modes.map(m=>({...m})));setReply('');setLocalError('');}}
 return <div className="panel">
  <h2>Modes</h2><StoragePanel revision={q.loadedAt} blocked={q.pending}/>
  <p>Angle, Acro and Level (Horizon) — experimental bench development. Remove propellers and keep motor power disconnected.</p>
  {!q.connected&&<p className="banner-warn">Connect your board first. No current board state is available.</p>}
  {(q.error||localError)&&<p role="alert" className="fail">{q.error||localError}</p>}
  <button disabled={!q.connected||q.pending} onClick={()=>void refresh()}>Refresh modes and discard drafts</button>
  <ModeReceiver drafts={drafts??[]} editable={editable} onAssign={(name,aux)=>edit(name,{aux})}/>
  {s&&<>
   <p className="banner-warn">{s.apiVersion===2?(configuredArm?'ARM range feeds the guarded arm switch. A fresh inactive-to-active transition is required; configuration alone never arms. Control-mode ranges remain bench-only.':'Control ranges route bench setpoints only after explicit AUX selection. ARM remains preview-only.'):'Legacy firmware: ARM and ANGLE are previews only; update both firmware and configurator for three-mode routing.'} {s.flightEnabled?'Firmware reports flight enabled; experimental mode-source changes are disabled here.':'Flight disabled in this firmware.'} Not flight-qualified.</p>
   {s.source==='mock'&&<p>DEMO — no radio or motor hardware. Switch activity is not simulated.</p>}
   <p>Last snapshot: {new Date(q.loadedAt).toLocaleTimeString()}. Armed: {s.armed?'yes':'no'}; motor bench: {s.benchActive?'active':'inactive'}; calibration: {s.apiVersion===1?'not reported':s.calibrationActive?'active':'inactive'}; receiver fresh: {s.rxFresh?'yes':'no'}. These are snapshots, not continuously updated indicators.</p>
   {s.apiVersion===2&&<fieldset disabled={!sourceEditable}>
    <legend>Control source: {s.controlSource==='aux'?'AUX switches':'Manual'}</legend>
    <p>Requested at snapshot: <strong>{modeLabel(s.requestedMode)}</strong>. Last controller pass: <strong>{modeLabel(s.effectiveMode)}</strong>. The controller can override the request during failsafe.</p>
    <button disabled={!sourceEditable||s.controlSource==='manual'} onClick={()=>void source('manual')}>Use manual selection</button>{' '}
    <button disabled={!sourceEditable||s.controlSource==='aux'} onClick={()=>void source('aux')}>Enable AUX mode selection</button>
    <p>Manual uses the CLI selection (<code>control_mode angle|acro|horizon</code>), defaulting to Angle. Configure non-overlapping ranges before enabling AUX.</p>
   </fieldset>}
   {s.modeConflict&&<p role="alert" className="banner-warn">Conflicting control ranges: Angle fallback. Remove the overlap and refresh before further bench checks.</p>}
   {s.controlSource==='aux'&&!s.rxFresh&&<p className="banner-warn">Receiver data is stale or unavailable. AUX selection falls back to Angle.</p>}
   {drafts?.map(m=><fieldset key={m.name} disabled={!editable}>
    <legend>{label(m.name)}</legend><p>{m.name==='ARM'&&configuredArm?'This range assigns the arm switch independently of manual/AUX control-mode selection. Outside the range disarms with a fresh receiver frame. Disabled or invalid input blocks arming; all existing health, low-throttle, failsafe and firmware lockout checks still apply.':descriptions[m.name]}</p>
    <p>Range matched at snapshot: {s.modes.find(r=>r.name===m.name)?.active?'yes':'no'} — not proof of arming or active physical control.</p>
    <label><input type="checkbox" checked={m.enabled} onChange={e=>edit(m.name,{enabled:e.target.checked})}/> Enabled</label>{' '}
    <label>AUX <select aria-label={`${m.name} AUX`} value={m.aux} onChange={e=>edit(m.name,{aux:Number(e.target.value)})}>{Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>AUX{i+1}</option>)}</select></label>{' '}
    <label>Minimum <input aria-label={`${m.name} minimum`} type="number" min={900} max={2100} step={1} value={m.minUs} onChange={e=>edit(m.name,{minUs:e.target.valueAsNumber})}/></label>{' '}
    <label>Maximum <input aria-label={`${m.name} maximum`} type="number" min={900} max={2100} step={1} value={m.maxUs} onChange={e=>edit(m.name,{maxUs:e.target.valueAsNumber})}/></label>{' '}
    <button disabled={!editable} onClick={()=>void apply(m)}>Apply {m.name==='HORIZON'?'Level (Horizon)':m.name}</button>
   </fieldset>)}
  </>}
  <p>AUX1–12 use equivalent microseconds (900–2100), not measured PWM pulses. No match, stale receiver data or overlapping control ranges fall back to Angle. Live switch positions update above; refresh modes to read the controller’s applied mode snapshot.</p>
  <p>Apply updates the running configuration; Save to controller retains all mode ranges and manual/AUX selection after a power cycle. The attitude estimator and sensor qualification remain required—even in Acro/Horizon. Do not attempt flight or flips.</p>
  {reply&&<p role="status">{reply}</p>}
 </div>;
}
