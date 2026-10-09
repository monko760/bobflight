import {useEffect,useRef,useState} from 'react';
import type {SensorSnapshot,ActionGateResult} from '../sensors/telemetry';
export function BoardOrientationPanel({snapshot,fresh,gate,command,onDirty}:{snapshot:SensorSnapshot|null;fresh:boolean;gate:ActionGateResult;command:(cmd:string)=>Promise<string|undefined>;onDirty:(dirty:boolean)=>void}){
 const [draft,setDraft]=useState(['0','0','0']),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const busyRef=useRef(false);
 const supported=snapshot?.board_alignment_api===1;
 const configured=snapshot?.board_align_configured?.join(' ');
 useEffect(()=>{if(!supported){setDirty(false);setMessage('');}},[supported]);
 const shownDraft=dirty?draft:(configured?.split(' ')??draft);
 useEffect(()=>{onDirty(dirty||busy);return()=>onDirty(false);},[dirty,busy,onDirty]);
 const valid=shownDraft.every(s=>/^-?\d+$/.test(s)&&Math.abs(Number(s))<=180);
 async function apply(){
  if(!gate.allowed||!valid||!dirty||busyRef.current)return;busyRef.current=true;setBusy(true);setMessage('');
  try{for(const [i,axis] of ['roll','pitch','yaw'].entries()){
    const reply=await command(`set align_board_${axis} ${Number(draft[i])}`);
    if(!reply||!reply.startsWith('ok '))throw Error('Mounting update incomplete. Inspect configured values before saving.');
   }setDirty(false);setMessage('Mounting settings staged. Save to controller, then reboot. Recalibrate after reboot; the live model remains in the active frame until then.');
  }catch(e){setMessage(String(e));}finally{busyRef.current=false;setBusy(false);}
 }
 return <section className="panel" aria-label="Aircraft board orientation">
  <h3>Aircraft board orientation</h3>
  <p>Additional rotation relative to the stock board mounting, not a replacement for factory IMU alignment. Roll, then pitch, then yaw. Whole degrees from -180 to 180.</p>
  {!supported?<p>Update firmware to configure aircraft mounting. Existing factory alignment is unchanged.</p>:<>
   <p>Configured: {configured}°. Active: {snapshot?.board_align_active?.join(' ')}° {fresh?'':'(stale)'}</p>
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{['Roll','Pitch','Yaw'].map((axis,i)=><label key={axis}>{axis} (°) <input aria-label={`Board ${axis.toLowerCase()}`} type="number" min={-180} max={180} step={1} value={shownDraft[i]} disabled={!gate.allowed||busy} onChange={e=>{setDraft(shownDraft.map((v,j)=>j===i?e.target.value:v));setDirty(true);setMessage('');}}/></label>)}</div>
   <button disabled={!gate.allowed||busy} onClick={()=>{setDraft(['180','0',shownDraft[2]]);setDirty(true);setMessage('Preset selected locally. Apply, Save and reboot are still required.');}}>Upside-down, keep yaw</button>{' '}
   <button disabled={!gate.allowed||!valid||busy||!dirty} onClick={()=>void apply()}>Apply mounting settings</button>{' '}
   <button disabled={busy||!configured} onClick={()=>{setDraft(configured!.split(' '));setDirty(false);setMessage('Local draft discarded. Configured settings on the controller are unchanged.');}}>Discard local draft</button>
   {!valid&&<p role="alert">Enter three whole-degree angles between -180 and 180.</p>}
   {snapshot?.board_align_reboot_required&&<p role="alert">Mounting change requires Save and reboot. Old-frame accelerometer calibration will not be saved; calibrate again after reboot.</p>}
   {!gate.allowed&&<p>{gate.reasons.join('; ')}</p>}
  </>}
  {message&&<p role="status">{message}</p>}
  <p>The upside-down preset flips Y and Z while preserving the configured yaw. If the board also points backward or sideways, set yaw accordingly. Verify the model's roll and pitch directions after reboot, with propellers removed.</p>
 </section>;
}
