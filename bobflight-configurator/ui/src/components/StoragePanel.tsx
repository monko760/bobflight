/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {parseStorage,parseConfigurationExport,canSaveStorage,type StorageSnapshot} from '../protocol';
export function StoragePanel({revision=0,blocked=false}:{revision?:number;blocked?:boolean}){
 const {host,connectionStatus,postFlashGate}=useHost();
 const connected=connectionStatus==='connected'&&!postFlashGate;
 const [state,setState]=useState<StorageSnapshot|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const epoch=useRef(0),busy=useRef(false);
 const live=(id:number)=>id===epoch.current&&host.getConnectionStatus()==='connected';
 async function run(action:'refresh'|'save'|'diff'|'dump'){
  if(!connected||busy.current||blocked)return;
  const id=epoch.current;busy.current=true;setPending(true);setError('');setMessage('');
  try{
   if(action==='save'){
    const before=parseStorage(await host.sendCommand('storage'));if(!live(id))return;
    if(!canSaveStorage(before,true,false))throw Error('Flash save unavailable: disarm, stop motors, and connect supported firmware.');
    await host.saveSettings();if(!live(id))return;
   }
   if(action==='diff'||action==='dump'){
    const raw=await host.sendCommand(action==='diff'?'diff all':'dump all');if(!live(id))return;
    const data=parseConfigurationExport(raw,action);
    const url=URL.createObjectURL(new Blob([data.raw],{type:'text/plain'}));
    try{const a=document.createElement('a');a.href=url;a.download=`bobflight-${data.board}-${data.firmware}-${action}-config.txt`;a.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
    setMessage('Exported runtime configuration. Calibration metadata cannot be replayed; retain controller flash or recalibrate if it is lost. Export does not save to the controller.');
   }
   const next=parseStorage(await host.sendCommand('storage'));if(!live(id))return;
   if(action==='save'&&(next.backend!=='flash'||next.state!=='saved'||next.dirty))throw Error('Save readback was not verified.');
   setState(next);if(action==='save')setMessage('Saved to controller flash and verified. Confirm once with a complete power-cycle test.');
  }catch(e){if(live(id)){setState(null);setError(String(e));}}
  finally{if(id===epoch.current){busy.current=false;setPending(false);}}
 }
 useEffect(()=>{++epoch.current;busy.current=false;setState(null);setError('');setMessage('');setPending(false);if(connected&&!blocked)void run('refresh');return()=>{++epoch.current;};},[host,connected,revision,blocked]);
 const canSave=canSaveStorage(state,connected,pending||blocked);
 return <section aria-label="Controller storage" className="panel">
  <h3>Controller storage & backups</h3>
  <p>Apply edits first, then Save to controller. Save includes PID/rates, receiver UART/map, all mode ranges, manual mode and manual/AUX selection. Schema 2 also saves validated, applied accelerometer calibration. Gyro bias, power settings and DShot speed are excluded. Calibration numbers in exports are diagnostic metadata, not replayable calibration commands.</p>
  <p>{!connected?'Disconnected — no current storage status.':state?`${state.backend==='flash'?'Controller flash':state.backend==='host_sim'?'Host simulation — not physical storage':'Unsupported'} · ${state.state} · ${state.dirty?'unsaved changes':'no unsaved changes'} · generation ${state.generation}`:'Storage capability not yet verified.'}</p>
  <button disabled={!canSave} onClick={()=>void run('save')}>Save to controller</button>{' '}
  <button disabled={!connected||pending||blocked} onClick={()=>void run('refresh')}>Refresh storage</button>{' '}
  <button disabled={!connected||!state||pending||blocked} onClick={()=>void run('diff')}>Export changes</button>{' '}
  <button disabled={!connected||!state||pending||blocked} onClick={()=>void run('dump')}>Export full configuration</button>
  {error&&<p role="alert">{error} Legacy/demo firmware cannot confirm controller flash storage. Do not treat an old “saved” reply as permanent storage.</p>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
