/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {isGateBusy,isGateNotSent,type CliCommand} from '../protocol';
import {STORAGE_BUSY_RETRIES,STORAGE_BUSY_RETRY_MS} from '../components/storageSequence';
/** Shown when the shared gate rejected a load/apply before it reached the FC (busy after the retries, queue timeout, cancel, disconnect drain, session change). */
export const SNAPSHOT_NOT_SENT_TEXT='Another command was using the connection, so nothing was sent. Try again.';
export function useConfigSnapshot<T>(query:CliCommand,parse:(s:string)=>T){
 const {host,connectionStatus,postFlashGate}=useHost();const connected=connectionStatus==='connected'&&!postFlashGate;
 const [snapshot,setSnapshot]=useState<T|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[loadedAt,setLoadedAt]=useState(0);
 const epoch=useRef(0),busy=useRef(false);
 /**
  * The first line of a load/apply, retried (bounded, STORAGE_BUSY_RETRIES x STORAGE_BUSY_RETRY_MS) only while
  * the shared gate refuses it as busy (isGateBusy: its stable code GATE_QUEUE_FULL / GATE_BUSY_START, never the
  * message text; a gate that is merely in use queues the read instead). Any other gate rejection (isGateNotSent:
  * queue timeout, cancel, drain, session change) is shown as "nothing sent", not retried. A controller reply or any
  * other error (even one whose text says "busy") is never retried; the read-back is never retried (and once the
  * first line went out, a gate rejection of the read-back is never shown as "nothing sent").
  */
 async function sendFirst(command:CliCommand,id:number):Promise<string>{
  for(let attempt=0;;attempt++){
   try{return await host.sendCommand(command);}
   catch(e){if(!isGateBusy(e)||attempt>=STORAGE_BUSY_RETRIES||id!==epoch.current)throw e;await new Promise(r=>setTimeout(r,STORAGE_BUSY_RETRY_MS));}
  }
 }
 async function execute(command:CliCommand=query,verify?:(v:T)=>void):Promise<T|null>{
  if(!connected||busy.current||host.getConnectionStatus()!=='connected')return null;
  const id=epoch.current;busy.current=true;setPending(true);setError('');
  let firstSent=false;
  try{const response=await sendFirst(command,id);firstSent=true;if(id!==epoch.current||host.getConnectionStatus()!=='connected')return null;
   if(/refused|failed|unknown/i.test(response))throw Error(response.trim());
   const raw=command===query||query==='modes'?response:await host.sendCommand(query);
   if(id!==epoch.current||host.getConnectionStatus()!=='connected')return null;
   const v=parse(raw);verify?.(v);setSnapshot(v);setLoadedAt(Date.now());return v;
  }catch(e){if(id===epoch.current){setSnapshot(null);setLoadedAt(0);setError(!firstSent&&isGateNotSent(e)?`${SNAPSHOT_NOT_SENT_TEXT} (${e instanceof Error?e.message:String(e)})`:String(e));}return null;}
  finally{if(id===epoch.current){busy.current=false;setPending(false);}}
 }
 useEffect(()=>{++epoch.current;busy.current=false;setSnapshot(null);setLoadedAt(0);setError('');setPending(false);if(connected)void execute();return()=>{++epoch.current;};},[host,connected]);
 return {snapshot,error,pending,loadedAt,connected,execute};
}
