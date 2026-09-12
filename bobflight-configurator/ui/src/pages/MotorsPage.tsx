import { useState } from "react";
import { useBenchTelemetry } from "../hooks/useBenchTelemetry";
export function MotorsPage(){
  const {connected,status,error,reply,pending,command}=useBenchTelemetry();
  const [propsOff,setPropsOff]=useState(false);
  const ready=connected&&status?.motor_output==="DShot300 ready"&&status?.arm==="disarmed";
  return <div className="panel"><h2>Motors · DShot300</h2>
    <p>Bench test: each press requests one motor at 8% for at most one second. Verify order and rotation before flight development continues.</p>
    <p>Output: {status?.motor_output??"—"} · Bound outputs: {status?.dshot_bound??"—"}</p>
    <div className="banner-warn">Remove all propellers. Motor tests need the flight battery connected and the quad secured. USB alone does not power the ESCs.</div>
    <label><input type="checkbox" checked={propsOff} onChange={e=>setPropsOff(e.target.checked)}/> All propellers are removed and the quad is secured</label>
    <div className="row" style={{marginTop:"1rem"}}>{([1,2,3,4] as const).map((motor,i)=><button key={motor} disabled={!ready||!propsOff||pending} onClick={()=>void command(`motor_test ${motor}`)}>M{motor} · {["rear right","front right","rear left","front left"][i]}</button>)}</div>
    <button className="danger" style={{marginTop:"1rem"}} disabled={!connected} onClick={()=>void command("motor_test 0")}>Stop motor test</button>
    <p className="muted">The firmware also ends the pulse if the USB connection is lost. These tests do not enable flight arming.</p>
    {reply&&<p>{reply}</p>}{error&&<p className="fail">{error}</p>}
  </div>;
}
