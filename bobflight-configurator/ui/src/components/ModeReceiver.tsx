/* SPDX-License-Identifier: Apache-2.0 */
import type {ModeRow} from '../protocol';
import {auxMicroseconds,useModeReceiver} from '../hooks/useModeReceiver';

export function ModeReceiver({drafts,editable,onAssign}:{drafts:ModeRow[];editable:boolean;onAssign:(name:ModeRow['name'],aux:number)=>void}){
 const {connected,reading,changed,error}=useModeReceiver();
 const live=connected&&reading?.link==='live';
 const detected=live&&changed.length===1?changed[0]:null;
 const canAssign=editable&&live&&reading?.armed===0&&reading?.bench_active===0;
 return <section aria-label="Live receiver switches">
  <h3>Find your switches</h3>
  <p>Move one transmitter switch at a time. Watch its AUX channel change, then use that channel for a mode below. Assignment changes your draft; Apply and Save to controller are still required.</p>
  <p role="status">{!connected?'Connect your board to see switches.':!live?'Waiting for live receiver data.':changed.length===1?`Last moved: AUX${detected}`:changed.length>1?`Multiple channels moved: ${changed.map(n=>`AUX${n}`).join(', ')}. Move just one switch to identify it.`:'Receiver live — move a switch to identify its AUX channel.'}</p>
  {error&&<p role="alert">{error}</p>}
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))',gap:'0.6rem'}}>
   {Array.from({length:12},(_,i)=>{
    const aux=i+1,value=live?auxMicroseconds(reading!.channels[i+4]):null;
    return <div key={aux} style={{padding:'0.5rem',border:live&&changed.includes(aux)?'2px solid #60a5fa':'2px solid transparent'}}>
     <strong>AUX{aux}</strong> · CH{i+5}: {value===null?'—':`${value} µs`}
     {value!==null&&<meter aria-label={`AUX${aux} position`} min={1000} max={2000} value={value} style={{display:'block',width:'100%'}}/>}
    </div>;
   })}
  </div>
  {drafts.map(m=>{
   const value=live?auxMicroseconds(reading!.channels[m.aux+3]):null;
   const matches=value!==null&&m.enabled&&value>=m.minUs&&value<=m.maxUs;
   return <p key={m.name}>
    <strong>{m.name==='HORIZON'?'Level (Horizon)':m.name}</strong> draft · AUX{m.aux}: {value===null?'—':`${value} µs`} · {value===null?'No live preview':matches?'Inside draft range':m.enabled?'Outside draft range':'Range disabled'}{' '}
    <button disabled={!canAssign||detected===null} onClick={()=>{if(canAssign&&detected!==null)onAssign(m.name,detected);}}>Use {detected===null?'detected AUX':`AUX${detected}`} for {m.name}</button>
   </p>;
  })}
  <p className="muted">Values are equivalent microseconds. Highlighting shows the last detected movement, not a switch name. Draft matches are previews, not confirmation that a mode is active.</p>
 </section>;
}
