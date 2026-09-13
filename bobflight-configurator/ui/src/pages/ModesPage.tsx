import {useEffect,useState} from 'react';
import {parseModes,modeRangeCommand,type ModeRow} from '../protocol';
import {useConfigSnapshot} from './useConfigSnapshot';
export function ModesPage(){
 const q=useConfigSnapshot('modes',parseModes),s=q.snapshot;const [drafts,setDrafts]=useState<ModeRow[]|null>(null),[reply,setReply]=useState(''),[localError,setLocalError]=useState('');
 useEffect(()=>{if(!q.connected){setDrafts(null);setReply('');}else if(s&&drafts===null)setDrafts(s.modes.map(m=>({...m})));},[s,q.connected,drafts]);
 const editable=q.connected&&!!s&&!s.armed&&!s.benchActive&&!q.pending;
 function edit(name:string,patch:Partial<ModeRow>){setReply('');setDrafts(old=>old?.map(m=>m.name===name?{...m,...patch}:m)??null);}
 async function apply(m:ModeRow){if(!editable)return;setLocalError('');setReply('');try{const cmd=modeRangeCommand(m);const result=await q.execute(cmd,v=>{const r=v.modes.find(r=>r.name===m.name);if(!r||['enabled','aux','minUs','maxUs'].some(k=>r[k as keyof ModeRow]!==m[k as keyof ModeRow]))throw Error('Mode readback does not match request');});if(result){setDrafts(old=>old?.map(x=>x.name===m.name?{...result.modes.find(r=>r.name===m.name)!}:x)??null);setReply(`${m.name} saved in RAM and verified by readback.`);}}catch(e){setLocalError(String(e));}}
 async function refresh(){const result=await q.execute();if(result){setDrafts(result.modes.map(m=>({...m})));setReply('');setLocalError('');}}
 return <div className="panel"><h2>Modes</h2><p>Remove propellers. AUX labels are shown here; commands use numeric AUX indices 1–12.</p>
 {!q.connected&&<p className="banner-warn">Connect your board first.</p>}{(q.error||localError)&&<p role="alert" className="fail">{q.error||localError}</p>}
 <button disabled={!q.connected||q.pending} onClick={()=>void refresh()}>Refresh modes and discard drafts</button>
 {s&&<><p className="banner-warn">{s.semantics==='preview'?'Preview only: these ranges do NOT change arming or flight-mode behavior.':'Firmware reports control semantics.'} {s.flightEnabled?'Firmware reports flight enabled; this is not a safety qualification.':'Flight disabled in this firmware.'}</p>
 {s.source==='mock'&&<p>DEMO — no radio or motor hardware.</p>}<p>Last snapshot: {new Date(q.loadedAt).toLocaleTimeString()}. Armed: {s.armed?'yes':'no'}; motor bench: {s.benchActive?'active':'inactive'}; receiver fresh at snapshot: {s.rxFresh?'yes':'no'}. These are not continuously updated indicators.</p>
 {drafts?.map(m=><fieldset key={m.name} disabled={!editable}><legend>{m.name}</legend><p>Range matched at snapshot: {s.modes.find(r=>r.name===m.name)?.active?'yes':'no'} — not actual armed state.</p>
 <label><input type="checkbox" checked={m.enabled} onChange={e=>edit(m.name,{enabled:e.target.checked})}/> Enabled</label>{' '}
 <label>AUX <select aria-label={`${m.name} AUX`} value={m.aux} onChange={e=>edit(m.name,{aux:Number(e.target.value)})}>{Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>AUX{i+1}</option>)}</select></label>{' '}
 <label>Minimum <input aria-label={`${m.name} minimum`} type="number" min={900} max={2100} step={1} value={m.minUs} onChange={e=>edit(m.name,{minUs:e.target.valueAsNumber})}/></label>{' '}
 <label>Maximum <input aria-label={`${m.name} maximum`} type="number" min={900} max={2100} step={1} value={m.maxUs} onChange={e=>edit(m.name,{maxUs:e.target.valueAsNumber})}/></label>{' '}
 <button disabled={!editable} onClick={()=>void apply(m)}>Apply {m.name} until reboot</button></fieldset>)}</>}
 <p>Ranges use equivalent microseconds (900–2100), not measured PWM pulses. Settings are session-only, reset at reboot, and are not persisted by Save. Refresh to inspect switch positions; an active range does not prove it is safe to arm.</p>{reply&&<p role="status">{reply}</p>}</div>;
}
