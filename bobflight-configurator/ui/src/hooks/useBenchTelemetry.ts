import { useEffect, useRef, useState } from "react";
import { useHost } from "./useHost";
import type { CliCommand } from "../protocol/types";

/** Poll only while this page is mounted; serialize actions with status requests. */
export function useBenchTelemetry() {
  const context=useHost();
  const {connectionStatus,refreshStatus,host}=context;
  const connected=connectionStatus==="connected";
  const [error,setError]=useState<string|null>(null);
  const [reply,setReply]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const chain=useRef<Promise<unknown>>(Promise.resolve());
  useEffect(()=>{
    if(!connected)return;
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    const tick=()=>{
      chain.current=chain.current.catch(()=>{}).then(async()=>{
        if(cancelled)return;
        try{await refreshStatus();if(!cancelled)setError(null);}
        catch(e){if(!cancelled)setError(e instanceof Error?e.message:String(e));}
      }).finally(()=>{if(!cancelled)timer=setTimeout(tick,400);});
    };
    tick();return()=>{cancelled=true;clearTimeout(timer);};
  },[connected,refreshStatus]);
  async function command(cmd:CliCommand){
    setPending(true);setReply(null);
    const operation=chain.current.catch(()=>{}).then(async()=>{
      const text=await host.sendCommand(cmd);
      if(/unknown|unsupported|refused|failed/i.test(text))throw new Error(text.trim());
      setReply(text.trim());await refreshStatus();
    });
    chain.current=operation;
    try{await operation;setError(null);}catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setPending(false);}
  }
  return {...context,connected,error,reply,pending,command};
}
export function numbers(text:string|undefined){
  if(!text)return [];
  const values=text.trim().split(/\s+/).map(Number);
  return values.every(Number.isFinite)?values:[];
}
