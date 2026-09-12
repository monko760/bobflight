/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {useHost} from "./useHost";
import type {CliCommand} from "../protocol/types";
import {checkActionGates,isSnapshotFresh,parseKeyValueSnapshot,type SensorSnapshot} from "../sensors/telemetry";
import {SensorRequestLane} from "../sensors/requestLane";

export function useSensorTelemetry(){
  const {host,connectionStatus}=useHost();
  const connected=connectionStatus==="connected";
  const lane=useMemo(()=>new SensorRequestLane(),[host]);
  const [session,setSession]=useState(0);
  const [snapshot,setSnapshot]=useState<SensorSnapshot|null>(null);
  const [fresh,setFresh]=useState(false),[fps,setFps]=useState(0);
  const [error,setError]=useState<string|null>(null),[reply,setReply]=useState<string|null>(null);
  const [commandError,setCommandError]=useState<string|null>(null);
  const [pending,setPending]=useState(false),[oldFirmware,setOldFirmware]=useState(false);
  const [propsOff,setPropsOff]=useState(false),[stationary,setStationary]=useState(false);
  const latest=useRef<SensorSnapshot|null>(null),received=useRef(0),advanced=useRef(0);
  const times=useRef<number[]>([]),detailed=useRef(false),confirmations=useRef({propsOff,stationary});
  confirmations.current={propsOff,stationary};
  const resetTelemetry=useCallback(()=>{
    latest.current=null;received.current=advanced.current=0;times.current=[];
    setSnapshot(null);setFresh(false);setFps(0);
  },[]);
  const pollDetailedCalibration=useCallback((enable=true)=>{detailed.current=enable;},[]);
  // Observe actual host transitions too: a fast disconnect/reconnect must not be
  // hidden by React batching the status updates into a single connected render.
  useEffect(()=>host.onStatus(()=>{
    lane.invalidate();resetTelemetry();setPropsOff(false);setStationary(false);
    setPending(false);setReply(null);setCommandError(null);setError(null);setOldFirmware(false);setSession(n=>n+1);
  }),[host,lane,resetTelemetry]);
  useEffect(()=>{
    lane.invalidate();resetTelemetry();
    if(!connected || oldFirmware)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const isFreshNow=()=>isSnapshotFresh(latest.current,null,received.current,performance.now()) && performance.now()-advanced.current<=250;
    const tick=async()=>{
      if(disposed || document.visibilityState!=="visible")return;
      const generation=lane.generation,start=performance.now();
      try{
        const result=await lane.read(()=>host.sendCommand(detailed.current?"calibration":"sensors"));
        if(disposed || generation!==lane.generation || document.visibilityState!=="visible")return;
        if(result!==null){
          const parsed=parseKeyValueSnapshot(result);
          if(!parsed){
            resetTelemetry();
            if(/unknown|unsupported/i.test(result)){
              setOldFirmware(true);setError("Update firmware required: sensor telemetry is not supported.");return;
            }
            throw new Error("Malformed or incomplete sensor snapshot; readings discarded");
          }
          const now=performance.now();
          // Include the whole request RTT conservatively: a delayed USB reply
          // must not turn an old device sample into apparently fresh data.
          parsed.sensor_age_ms=Math.min(0xffffffff,parsed.sensor_age_ms+Math.ceil(now-start));
          if(parsed.sample_seq!==0 && parsed.sample_seq!==latest.current?.sample_seq){
            advanced.current=now;times.current.push(now);
          }
          received.current=now;latest.current=parsed;
          setSnapshot(parsed);setFresh(isFreshNow());setError(null);
        }
      }catch(e){
        if(!disposed && generation===lane.generation){
          const msg=e instanceof Error?e.message:String(e);
          if(!/another.*command.*in flight|request not queued|busy/i.test(msg)){setError(msg);resetTelemetry();}
        }
      }finally{
        if(!disposed && document.visibilityState==="visible" && generation===lane.generation)
          timer=setTimeout(tick,Math.max(5,50-(performance.now()-start)));
      }
    };
    // Expire samples even during a blocked request or when another page owns USB.
    const ageTimer=setInterval(()=>{
      if(disposed)return;
      const now=performance.now();times.current=times.current.filter(t=>now-t<=1000);
      const valid=document.visibilityState==="visible" && isFreshNow();
      setFresh(valid);setFps(valid?times.current.length:0);
    },50);
    const visibility=()=>{
      lane.invalidate();if(timer)clearTimeout(timer);resetTelemetry();setPending(false);setReply(null);setCommandError(null);
      setPropsOff(false);setStationary(false);
      if(document.visibilityState==="visible")void tick();
      // No deferred cancel across USB sessions. Firmware expires the manual
      // calibration lease after two seconds without sensor-page queries.
    };
    document.addEventListener("visibilitychange",visibility);void tick();
    return()=>{disposed=true;lane.invalidate();if(timer)clearTimeout(timer);clearInterval(ageTimer);document.removeEventListener("visibilitychange",visibility);};
  },[connected,host,lane,oldFirmware,session,resetTelemetry]);
  const command=useCallback(async(cmd:string):Promise<string|undefined>=>{
    if(lane.hasPendingAction)return;
    const cancel=cmd==="calibration_cancel" || cmd==="calibrate_accel cancel";
    const action=cancel?"accel_cancel":cmd==="calibrate_gyro"?"gyro_cal":cmd==="calibrate_accel start"?"accel_start":cmd==="calibrate_accel apply"?"accel_apply":/^calibrate_accel [+-][xyz]$/.test(cmd)?"accel_face":null;
    if(!action){setCommandError("Unsupported calibration command");return;}
    const generation=lane.generation;setPending(true);setReply(null);setCommandError(null);
    try{
      const text=await lane.action(async()=>{
        if(document.visibilityState!=="visible")throw new Error("Sensor page is hidden");
        const currentFresh=isSnapshotFresh(latest.current,null,received.current,performance.now()) && performance.now()-advanced.current<=250;
        const gate=checkActionGates(action,{connected:host.getConnectionStatus()==="connected",snapshot:latest.current,fresh:currentFresh,...confirmations.current});
        if(!gate.allowed)throw new Error(gate.reasons.join("; "));
        return host.sendCommand(cmd as CliCommand);
      });
      if(generation!==lane.generation)return;
      if(/unknown|unsupported|refused|failed/i.test(text))throw new Error(text.trim());
      setReply(text.trim());setCommandError(null);return text.trim();
    }catch(e){if(generation===lane.generation)setCommandError(e instanceof Error?e.message:String(e));}
    finally{if(generation===lane.generation)setPending(false);}
  },[host,lane]);
  return {connected,snapshot,fresh,fps,error:[commandError,error].filter(Boolean).join(" — ")||null,reply,pending,oldFirmware,propsOff,setPropsOff,stationary,setStationary,command,pollDetailedCalibration,resetTelemetry};
}
