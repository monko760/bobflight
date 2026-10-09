import {useCallback,useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {parseStorage,canSaveStorage,type StorageSnapshot} from '../protocol';
import {RATES_DEFAULTS,getRates,type RatesConfig} from '../tuning/mockTuningStore';
import {mockSettingsApi,type RateKey} from '../tuning/mockSettingsApi';
import {AXES,rateAtStick,rateDraftValid,rateSaveEntries,readRateSettings} from '../tuning/actualRates';
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
export function RatesPage(){
 const {host,connectionStatus,postFlashGate}=useHost();
 const [values,setValues]=useState<RatesConfig>({...RATES_DEFAULTS});
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[preview,setPreview]=useState(false);
 const [supported,setSupported]=useState(false),[storage,setStorage]=useState<StorageSnapshot|null>(null);
 const [error,setError]=useState(''),[message,setMessage]=useState('');
 const epoch=useRef(0);
 const load=useCallback(async()=>{
  const token=++epoch.current;setReady(false);setPreview(false);setStorage(null);setError('');setMessage('');setBusy(false);
  if(connectionStatus!=='connected'){setError('Connect a controller, or choose Local preview.');return;}
  if(postFlashGate){setError('Verify the controller after flashing before editing rates.');return;}
  setBusy(true);
  try{
   const all=await host.getAllSettings();if(token!==epoch.current)return;
   const read=readRateSettings(all);let capability:StorageSnapshot|null=null;
   try{capability=parseStorage(await host.sendCommand('storage'));}catch(e){if(token===epoch.current)setError(`Storage capability unverified: ${errorText(e)}. Saving is disabled.`);}
   if(token!==epoch.current)return;
   const actual=!!capability&&capability.schema===13&&capability.lastError!=='fresh_install_required'&&capability.lastError!=='invalid_record';
   if(!actual)throw Error('Fresh install required: Actual rates need schema13 with initialized configuration storage.');
   setValues(read.values);setStorage(capability);setSupported(actual);setReady(true);
  }catch(e){if(token===epoch.current){setError(errorText(e));setReady(false);}}
  finally{if(token===epoch.current)setBusy(false);}
 },[host,connectionStatus,postFlashGate]);
 useEffect(()=>{void load();return()=>{epoch.current++;};},[load]);
 const valid=ready&&supported&&rateDraftValid(values);
 const canSave=valid&&!busy&&(preview||(!postFlashGate&&canSaveStorage(storage,connectionStatus==='connected',busy)));
 function update(key:RateKey,raw:string){setValues(v=>({...v,[key]:raw.trim()===''?NaN:Number(raw)}));setMessage('');}
 async function save(){
  if(!canSave)return;
  const token=epoch.current;setBusy(true);setError('');setMessage('');
  try{
   const entries=rateSaveEntries(values);
   if(preview){for(const [k,v]of entries)if(!mockSettingsApi.set(k,v).startsWith('ok '))throw Error('Invalid local preview setting');setMessage('Saved to local preview memory only. No controller was changed.');return;}
   for(const [k,v]of entries){if(token!==epoch.current||host.getConnectionStatus()!=='connected')throw Error('Connection changed; reload rates before continuing');await host.setSetting(k,v);}
   if(token!==epoch.current)throw Error('Connection changed before save');
   await host.saveSettings();if(token!==epoch.current)return;
   const after=readRateSettings(await host.getAllSettings());if(token!==epoch.current)return;
   for(const [k,v]of entries)if(Math.abs(after.values[k]-Number(v))>Math.max(1e-6,Math.abs(Number(v))*2e-6))throw Error(`Readback mismatch: ${k}`);
   const verified=parseStorage(await host.sendCommand('storage'));if(token!==epoch.current)return;
   if(verified.backend!=='flash'||verified.state!=='saved'||verified.dirty)throw Error('Final flash-save verification failed');
   setValues(after.values);setStorage(verified);setMessage('Saved to controller flash and read back.');
  }catch(e){if(token===epoch.current){setError(`${errorText(e)}. Some values may already be applied in RAM or saved. Reload before retrying.`);setReady(false);}}
  finally{if(token===epoch.current)setBusy(false);}
 }
 function localPreview(){epoch.current++;setValues(getRates());setSupported(true);setPreview(true);setStorage(null);setBusy(false);setReady(true);setError('');setMessage('Local preview only. No controller reads or writes.');}
 const ceiling=Math.max(100,...AXES.map(a=>Math.max(values[`rate_center_${a}`],values[`rate_max_${a}`])));
 const colors=['#ef6464','#51b88a','#599be8'];
 return <div className="panel">
  <h2>Rates</h2><p className="muted">Actual rates: independent center sensitivity, maximum rate and expo for each axis.</p>
  <div className="row"><button onClick={()=>void load()} disabled={busy}>Reload controller</button><button onClick={localPreview} disabled={busy}>Local preview</button></div>
  {preview&&<p className="muted">Preview memory only. These are not controller readings.</p>}
  <fieldset disabled={!ready||busy} style={{border:0,padding:0}}>
   <table style={{width:'100%',marginTop:'1rem'}}><thead><tr><th>Axis</th><th>Center sensitivity (deg/s)</th><th>Max rate (deg/s)</th><th>Expo (%)</th></tr></thead><tbody>
   {AXES.map(a=><tr key={a}><th style={{textTransform:'capitalize'}}>{a}</th>
    <td><input aria-label={`${a} center sensitivity`} id={`rate_center_${a}`} type="number" min={0} max={2000} step={10} value={Number.isFinite(values[`rate_center_${a}`])?values[`rate_center_${a}`]:''} onChange={e=>update(`rate_center_${a}`,e.target.value)}/></td>
    <td><input aria-label={`${a} max rate`} id={`rate_max_${a}`} type="number" min={10} max={2000} step={10} value={Number.isFinite(values[`rate_max_${a}`])?values[`rate_max_${a}`]:''} onChange={e=>update(`rate_max_${a}`,e.target.value)}/></td>
    <td><input aria-label={`${a} expo percent`} id={`rate_expo_${a}`} type="number" min={0} max={100} step={1} value={Number.isFinite(values[`rate_expo_${a}`])?Number((values[`rate_expo_${a}`]*100).toFixed(6)):''} onChange={e=>update(`rate_expo_${a}`,e.target.value===''?'':String(Number(e.target.value)/100))}/></td>
   </tr>)}</tbody></table>
  </fieldset>
  {AXES.filter(a=>values[`rate_center_${a}`]>values[`rate_max_${a}`]).map(a=><p className="fail" key={a}>{a}: center exceeds max. Like Betaflight Actual, the effective endpoint is {values[`rate_center_${a}`]} deg/s.</p>)}
  {ready&&!valid&&<p className="fail">Enter finite values within the shown ranges.</p>}
  {valid&&<><svg role="img" aria-label="Signed rate curves with 2 percent receiver deadband" viewBox="0 0 520 290" style={{width:'100%',maxWidth:720}}>
   {[-1,0,1].map(v=><g key={v}><line x1={55} x2={495} y1={135-v*105} y2={135-v*105} stroke="currentColor" opacity={.2}/><text x={3} y={140-v*105} fill="currentColor" fontSize={12}>{Math.round(v*ceiling)}</text></g>)}
   <line x1={275} x2={275} y1={30} y2={240} stroke="currentColor" opacity={.2}/>
   {AXES.map((a,i)=><path key={a} data-axis={a} fill="none" stroke={colors[i]} strokeWidth={2} d={Array.from({length:101},(_,k)=>{const x=k/50-1,y=rateAtStick(values,a,x);return `${k?'L':'M'}${(55+k*4.4).toFixed(2)},${(135-y/ceiling*105).toFixed(2)}`;}).join(' ')}/>)}
   <text x={55} y={260} fill="currentColor" fontSize={12}>-100%</text><text x={268} y={260} fill="currentColor" fontSize={12}>0</text><text x={460} y={260} fill="currentColor" fontSize={12}>100%</text><text x={125} y={285} fill="currentColor" fontSize={12}>Stick input (existing 2% deadband applied once)</text>
  </svg><p>{AXES.map((a,i)=><span key={a} style={{color:colors[i],marginRight:20}}>{a}: {rateAtStick(values,a,1).toFixed(0)} deg/s endpoint</span>)}</p></>}
  <div className="row"><button className="primary" disabled={!canSave} onClick={()=>void save()}>{preview?'Save preview':'Save to controller'}</button><button disabled={!ready||busy} onClick={()=>{setValues({...RATES_DEFAULTS});setMessage('Only the rate draft was reset. Nothing was sent or saved.');}}>Reset rate draft</button></div>
  {message&&<p className="muted">{message}</p>}{error&&<p className="fail" role="alert">{error}</p>}
 </div>;
}
