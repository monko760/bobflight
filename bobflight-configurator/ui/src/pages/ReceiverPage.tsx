import { useEffect, useRef, useState } from "react";
import { useHost } from "../hooks/useHost";
import type { CliCommand } from "../protocol";
import { parseReceiver, type ReceiverReading, type ReceiverMap } from "../protocol/receiver";

const ports=[1,2,3,4,6,7] as const;
const names=["Roll","Pitch","Yaw","Throttle",...Array.from({length:12},(_,i)=>`AUX${i+1}`)];
const linkLabels={unbound:"UART unavailable",waiting:"Waiting for valid channel frames",live:"Receiving live controls",lost:"Receiver signal lost"};

export function ReceiverPage() {
  const {host,connectionStatus,postFlashGate}=useHost();
  const connected=connectionStatus==="connected" && !postFlashGate;
  const [reading,setReading]=useState<ReceiverReading|null>(null);
  const [uart,setUart]=useState<number|null>(null);
  const [map,setMap]=useState<ReceiverMap|null>(null);
  const [error,setError]=useState("");
  const [reply,setReply]=useState("");
  const [pending,setPending]=useState(false);
  const [receivedAt,setReceivedAt]=useState(0);
  const [clock,setClock]=useState(0);
  const epoch=useRef(0), chain=useRef<Promise<unknown>>(Promise.resolve());
  function accept(next:ReceiverReading) {
    setReading(next);setReceivedAt(performance.now());setError("");
    setUart(old=>old??(ports.includes(next.uart as typeof ports[number])?next.uart:6));
    setMap(old=>old??next.map);
  }
  useEffect(()=>{
    const id=++epoch.current;
    let timer:ReturnType<typeof setTimeout>;
    setReading(null);setUart(null);setMap(null);setReply("");setError("");setPending(false);
    if(!connected)return;
    const watchdog=setInterval(()=>setClock(performance.now()),100);
    function poll() {
      chain.current=chain.current.catch(()=>{}).then(async()=>{
        if(id!==epoch.current)return;
        try {
          const next=parseReceiver(await host.sendCommand("receiver"));
          if(id===epoch.current)accept(next);
        } catch(e) { if(id===epoch.current){setReading(null);setError(String(e));} }
      }).finally(()=>{if(id===epoch.current)timer=setTimeout(poll,200);});
    }
    poll();
    return()=>{++epoch.current;clearTimeout(timer);clearInterval(watchdog);};
  },[host,connected]);
  const responding=connected && reading!==null && clock-receivedAt<750;
  const live=responding && reading?.link==="live";
  const editable=responding && reading?.armed===0 && reading?.bench_active===0 && !pending;
  async function apply(cmd:CliCommand) {
    if(!editable)return;
    const id=epoch.current;
    setPending(true);setReply("");
    const job=chain.current.catch(()=>{}).then(async()=>{
      if(id!==epoch.current || host.getConnectionStatus()!=="connected")return;
      const response=await host.sendCommand(cmd);
      if(/refused|failed|unknown|unsupported/i.test(response))throw new Error(response.trim());
      const next=parseReceiver(await host.sendCommand("receiver"));
      if(id!==epoch.current)return;
      accept(next);setUart(ports.includes(next.uart as typeof ports[number])?next.uart:6);setMap(next.map);
      setReply("Applied and read back from the board. Verify every control again. Settings reset at reboot.");
    });
    chain.current=job;
    try{await job;}catch(e){if(id===epoch.current)setError(String(e));}
    finally{if(id===epoch.current)setPending(false);}
  }
  return <div className="panel">
    <h2>Receiver · CRSF</h2>
    <p>Remove propellers, power the receiver and turn on your transmitter. Move one control at a time and check its name and direction below.</p>
    <p role="status" className={live?"":"banner-warn"}>
      {!connected?"Connect your board first.":!responding?"No current receiver diagnostics.":linkLabels[reading!.link]}
    </p>
    {error&&<p role="alert" className="fail">{error}</p>}
    <div style={{display:"flex",gap:"1rem",flexWrap:"wrap"}}>
      <span>Applied UART: {responding?reading!.uart:"—"}</span>
      <span>Applied order: {responding?reading!.map:"—"}</span>
      <span>Last packet age: {responding&&reading!.age_ms>=0?`${reading!.age_ms} ms`:"No frame"}</span>
      <span>Valid frames: {responding?reading!.frames:"—"}</span>
      <span>Failsafe: {responding?(reading!.failsafe?"Active":"Inactive"):"Unknown"}</span>
    </div>
    <h3>Receiver connection</h3>
    <label>Receiver TX wire connects to board pad <select value={uart??6} disabled={!editable} onChange={e=>setUart(Number(e.target.value))}>
      {ports.map(n=><option key={n} value={n}>R{n} / UART{n}</option>)}
    </select></label>{" "}
    <button disabled={!editable||uart===null} onClick={()=>void apply(`receiver_uart ${uart}` as CliCommand)}>Apply UART until reboot</button>
    <p><label>Transmitter channel order <select value={map??"AETR"} disabled={!editable} onChange={e=>setMap(e.target.value as ReceiverMap)}>
      <option value="AETR">AETR — Roll, Pitch, Throttle, Yaw</option>
      <option value="TAER">TAER — Throttle, Roll, Pitch, Yaw</option>
    </select></label>{" "}
    <button disabled={!editable||map===null} onClick={()=>void apply(`receiver_map ${map}` as CliCommand)}>Apply mapping until reboot</button></p>
    <p className="muted">CRSF uses 420000 baud. Defaults: UART6 and AETR. Configure the receiver’s serial output as CRSF. Settings changes require disarmed motors and no active bench test. Flash persistence is not available yet.</p>
    {reply&&<p role="status">{reply}</p>}
    <h3>Mapped controls</h3>
    {!live&&<p>Channel bars are hidden until valid, recent RC frames arrive. Last-known positions are not live controls.</p>}
    <table style={{width:"100%"}}><thead><tr><th>Control</th><th>Value</th><th>Position</th></tr></thead><tbody>
      {names.map((name,i)=><tr key={name}><td>{name}{i===4?" · Arm switch":""}</td>
        <td>{live?`${(reading!.channels[i]*100).toFixed(1)}%`:"—"}</td>
        <td>{live&&<meter aria-label={name} style={{width:"100%",minWidth:"120px"}} min={i===3?0:-1} max={1} value={reading!.channels[i]}/>}</td></tr>)}
    </tbody></table>
    <p className="muted">Roll, pitch and yaw should center near 0%. Throttle should span 0–100%. AUX1 is the arm switch; verify its low/high positions with props removed. This page never sends an arm command.</p>
    <details><summary>Connection troubleshooting</summary>
      <p>CRC errors: {responding?reading!.crc_errors:"—"} · Stream resets: {responding?reading!.stream_resets:"—"}</p>
      <p>Waiting: check receiver power, transmitter binding, CRSF output and the selected RX pad. Increasing CRC errors: check wiring, common ground and the receiver’s baud setting. A frame is stale after 250 ms without valid channel data.</p>
      <p>Frame count and counters restart after a UART or mapping change. RSSI/link-quality telemetry is not implemented in this version.</p>
    </details>
  </div>;
}
