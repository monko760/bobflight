/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {canSaveStorage,type StorageSnapshot} from '../protocol';
import {runStorageGated,readStorage,saveSequence,exportSequence,describeStorageError,StorageCancelledError,type StorageAction,type StorageProblem,type StorageResult} from './storageSequence';
import {requestRefresh,storageDirty,browserConfirm} from './storageRefresh';
import {AccelCalSavedNote} from './AccelCalSavedNote';
/**
 * Load, Save and Export each run as ONE gated storage sequence with a bounded
 * busy-only retry (storageSequence.ts). The panel reloads only on connect,
 * host change or `revision`; `blocked` flipping (a page poll error, a stale
 * sample) never resets or reloads it (G3). The automatic load waits until the
 * page first unblocks, one task after mount, so the page's own first read is
 * not refused by the panel holding the gate.
 *
 * onPending: told whenever a save / refresh / export starts or settles (and false on unmount), so a page can lock its own setters; it never feeds `blocked`. */
export function StoragePanel({revision=0,blocked=false,requiredScope,onPending}:{revision?:number|string;blocked?:boolean;requiredScope?:string;onPending?:(pending:boolean)=>void}){
 const {host,connectionStatus,postFlashGate}=useHost();
 const connected=connectionStatus==='connected'&&!postFlashGate;
 const [state,setState]=useState<StorageSnapshot|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<StorageProblem|null>(null),[message,setMessage]=useState('');
 const [storageRaw,setStorageRaw]=useState('');/* D1 accel_cal_saved line: the raw reply behind `state` */
 const epoch=useRef(0),busy=useRef(false);
 /** Aborted on unmount / revision change: drops this panel's commands still waiting in the shared CommandGate queue. */
 const abort=useRef<AbortController|null>(null);
 const live=(id:number)=>id===epoch.current&&host.getConnectionStatus()==='connected';
 /** mode: 'user' (a button), 'auto' (first load), 'quiet' (re-read after the page unblocks: keeps the shown status and message until it answers). */
 async function run(action:StorageAction,mode:'user'|'auto'|'quiet'='user'){
  if(!connected||busy.current||(blocked&&mode==='user'))return;
  const id=epoch.current;busy.current=true;setPending(true);if(mode!=='quiet'){setError(null);setMessage('');}
  try{
   const result:StorageResult=await runStorageGated(host,action,send=>
    action==='save'?saveSequence(send,requiredScope):
    action==='diff'||action==='dump'?exportSequence(send,action):
    readStorage(send),{cancelled:()=>!live(id),signal:abort.current?.signal});
   if(!live(id))return;
   if(result.export){
    const data=result.export;
    const url=URL.createObjectURL(new Blob([data.raw],{type:'text/plain'}));
    try{const a=document.createElement('a');a.href=url;a.download=`bobflight-${data.board}-${data.firmware}-${action}-config.txt`;a.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
    setMessage('Exported runtime configuration. Calibration metadata cannot be replayed; retain controller flash or recalibrate if it is lost. Export does not save to the controller.');
   }
   setState(result.snapshot);setStorageRaw(result.raw);setError(null);if(action==='save')setMessage('Saved to controller flash and verified. Confirm once with a complete power-cycle test.');
  }catch(e){
   if(e instanceof StorageCancelledError||!live(id))return;
   const problem=describeStorageError(e);
   if(mode==='quiet'&&problem.kind==='busy')return; // nothing was read; the shown status stands
   setError(problem);
   // Busy: nothing was read or sent, so the last verified status still stands. Anything else: status is no longer known.
   if(problem.kind!=='busy'){setState(null);setStorageRaw('');}
  }
  finally{if(id===epoch.current){busy.current=false;setPending(false);}}
 }
 useEffect(()=>{onPending?.(pending);},[pending,onPending]);
 useEffect(()=>()=>{onPending?.(false);},[onPending]);
 // Auto-load once per connect/host/revision. It waits while `blocked` (the page's own first read
 // goes first) and is deferred one task so a page's mount-time command gets the gate first.
 // When the page unblocks again (an apply finished), storage is re-read QUIETLY: the shown status
 // stays until the reply arrives. A `blocked` change never resets the panel (G3).
 const wantLoad=useRef(false),wantQuiet=useRef(false),wasBlocked=useRef(blocked);
 useEffect(()=>{++epoch.current;const mine=new AbortController();abort.current=mine;busy.current=false;wantLoad.current=connected;wantQuiet.current=false;setState(null);setStorageRaw('');setError(null);setMessage('');setPending(false);return()=>{++epoch.current;mine.abort();};},[host,connected,revision]);
 useEffect(()=>{
  if(wasBlocked.current&&!blocked&&!wantLoad.current)wantQuiet.current=true;
  wasBlocked.current=blocked;
  if(!connected||blocked||(!wantLoad.current&&!wantQuiet.current))return;
  const t=setTimeout(()=>{
   if(busy.current)return;
   if(wantLoad.current){wantLoad.current=false;wantQuiet.current=false;void run('refresh','auto');}
   else if(wantQuiet.current){wantQuiet.current=false;void run('refresh','quiet');}
  },0);
  return()=>clearTimeout(t);
 });
 const supported=!requiredScope||!!state?.scope.split(",").includes(requiredScope);
 const canSave=supported&&canSaveStorage(state,connected,pending||blocked);
 return <section aria-label="Controller storage" className="panel">
  <h3>Controller storage & backups</h3>
  <p>Apply edits first, then Save to controller. The connected firmware reports which settings it can save below. Schema 3 includes power settings and DShot speed as well as PID/rates, receiver, modes and applied accelerometer calibration. Gyro bias is measured again at startup. Calibration numbers in exports are diagnostic metadata, not replayable calibration commands.</p>
  <p data-testid="storage-status">{!connected?'Disconnected — no current storage status.':state?`${state.backend==='flash'?'Controller flash':state.backend==='host_sim'?'Host simulation — not physical storage':'Unsupported'} · ${state.state} · ${state.dirty?'unsaved changes':'no unsaved changes'} · generation ${state.generation}`:pending?'Reading storage status…':'Storage capability not yet verified.'}</p>
  <button disabled={!canSave} onClick={()=>void run('save')}>Save to controller</button>{' '}
  <button className="ghost" disabled={!connected||pending||blocked} onClick={()=>{requestRefresh({dirty:storageDirty(state),confirm:browserConfirm,refresh:()=>void run('refresh')});}}>Refresh storage</button>{' '}
  <button disabled={!connected||!state||pending||blocked} onClick={()=>void run('diff')}>Export changes</button>{' '}
  <button disabled={!connected||!state||pending||blocked} onClick={()=>void run('dump')}>Export full configuration</button>
  {state&&<AccelCalSavedNote raw={storageRaw}/>}
  {state&&state.lastError!=='none'&&<p role="alert">{state.lastError==='migrated_control_source_manual'?'Older AUX mode routing was restored as manual selection. Your stored manual mode and other settings were retained. Review Modes, then explicitly Save to controller to accept this migration.':`Controller storage notice: ${state.lastError}. Review the restored configuration before saving or testing.`}</p>}
  {state&&<p>Saved scope: {state.scope.replaceAll("_"," ").replaceAll(",",", ")}</p>}
  {blocked&&<p>Apply all edits on this page before saving, and finish any active operation.</p>}
  {!supported&&state&&<p role="alert">Update firmware to save this page’s settings. This firmware does not advertise that capability.</p>}
  {error&&<p role="alert" data-testid="storage-error">{error.text}</p>}
  {error?.detail&&<p className="muted" data-testid="storage-error-detail">{error.detail}</p>}
  {message&&<p role="status" data-testid="storage-message">{message}</p>}
 </section>;
}
