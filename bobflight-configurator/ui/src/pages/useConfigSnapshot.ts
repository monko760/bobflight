/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import type {CliCommand} from '../protocol';
import {isGateBusy} from '../protocol/commandGate';
import {STORAGE_BUSY_RETRIES,STORAGE_BUSY_RETRY_MS} from '../components/storageSequence';
export function useConfigSnapshot<T>(query:CliCommand,parse:(s:string)=>T){
 const {host,connectionStatus,postFlashGate}=useHost();const connected=connectionStatus==='connected'&&!postFlashGate;
 const [snapshot,setSnapshot]=useState<T|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[loadedAt,setLoadedAt]=useState(0);
 const epoch=useRef(0),busy=useRef(false);
 /**
  * The first line of a load/apply, retried (bounded, STORAGE_BUSY_RETRIES x STORAGE_BUSY_RETRY_MS) only while
  * the shared gate refuses it before anything is sent (since the P1 FIFO gate: its queue is full; a gate
  * that is merely in use queues the read instead). A controller reply or any other error is never retried; the read-back is never retried.
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
  try{const response=await sendFirst(command,id);if(id!==epoch.current||host.getConnectionStatus()!=='connected')return null;
   if(/refused|failed|unknown/i.test(response))throw Error(response.trim());
   const raw=command===query||query==='modes'?response:await host.sendCommand(query);
   if(id!==epoch.current||host.getConnectionStatus()!=='connected')return null;
   const v=parse(raw);verify?.(v);setSnapshot(v);setLoadedAt(Date.now());return v;
  }catch(e){if(id===epoch.current){setSnapshot(null);setLoadedAt(0);setError(String(e));}return null;}
  finally{if(id===epoch.current){busy.current=false;setPending(false);}}
 }
 useEffect(()=>{++epoch.current;busy.current=false;setSnapshot(null);setLoadedAt(0);setError('');setPending(false);if(connected)void execute();return()=>{++epoch.current;};},[host,connected]);
 return {snapshot,error,pending,loadedAt,connected,execute};
}
