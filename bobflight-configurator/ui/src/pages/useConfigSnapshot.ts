/* SPDX-License-Identifier: Apache-2.0 */
import {useEffect,useRef,useState} from 'react';
import {useHost} from '../hooks/useHost';
import type {CliCommand} from '../protocol';
export function useConfigSnapshot<T>(query:CliCommand,parse:(s:string)=>T){
 const {host,connectionStatus,postFlashGate}=useHost();const connected=connectionStatus==='connected'&&!postFlashGate;
 const [snapshot,setSnapshot]=useState<T|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[loadedAt,setLoadedAt]=useState(0);
 const epoch=useRef(0),busy=useRef(false);
 async function execute(command:CliCommand=query,verify?:(v:T)=>void):Promise<T|null>{
  if(!connected||busy.current||host.getConnectionStatus()!=='connected')return null;
  const id=epoch.current;busy.current=true;setPending(true);setError('');
  try{const response=await host.sendCommand(command);if(id!==epoch.current||host.getConnectionStatus()!=='connected')return null;
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
