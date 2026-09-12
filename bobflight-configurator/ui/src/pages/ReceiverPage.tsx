import { useState } from "react";
import { useBenchTelemetry, numbers } from "../hooks/useBenchTelemetry";
export function ReceiverPage(){
  const {connected,status,error,reply,pending,command}=useBenchTelemetry();
  const [uart,setUart]=useState<1|2|3|4|6|7>(6);
  const channels=numbers(status?.channels);
  return <div className="panel"><h2>Receiver · CRSF</h2>
    <p>Turn on the transmitter. Move each stick to confirm Roll, Pitch, Yaw and Throttle match. AUX1 is reserved for the arm switch in the future flight build.</p>
    {!connected&&<p className="fail">Connect the board first.</p>}
    <p>UART: {status?.rx_uart??"—"} · Fresh frames: {status?.rx_fresh??"—"} · Frames received: {status?.rx_frames??"—"}</p>
    <label>Receiver is wired to RX pad <select value={uart} onChange={e=>setUart(Number(e.target.value) as typeof uart)} disabled={!connected||pending||status?.arm==="armed"}>
      {[1,2,3,4,6,7].map(n=><option key={n} value={n}>R{n} / UART{n}</option>)}
    </select></label>{" "}<button disabled={!connected||pending||status?.arm==="armed"||!status?.rx_uart} onClick={()=>void command(`receiver_uart ${uart}`)}>Apply until reboot</button>
    <p className="muted">Defaults to UART6. Choose the pad already used by your receiver; no rewiring is required. Channel order assumes AETR on the transmitter.</p>
    <table><thead><tr><th>Control</th><th>Value</th><th>Position</th></tr></thead><tbody>
      {["Roll","Pitch","Yaw","Throttle","AUX1","AUX2","AUX3","AUX4"].map((name,i)=><tr key={name}><td>{name}</td><td>{channels[i]?.toFixed(3)??"—"}</td><td>{channels[i]!==undefined&&<meter min={i===3?0:-1} max={1} value={channels[i]}/>}</td></tr>)}
    </tbody></table>
    {status?.rx_fresh==="no"&&<p className="banner-warn">No recent valid RC frames. Check transmitter power, receiver power and UART selection. Last values may be stale.</p>}
    {reply&&<p>{reply}</p>}{error&&<p className="fail">{error}</p>}
  </div>;
}
