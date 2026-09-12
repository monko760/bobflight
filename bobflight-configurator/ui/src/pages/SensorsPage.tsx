import { useEffect, useState } from "react";
import { useBenchTelemetry, numbers } from "../hooks/useBenchTelemetry";

export function SensorsPage() {
  const {connected,status,error,reply,pending,command}=useBenchTelemetry();
  const [lastSample,setLastSample]=useState(0);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(connected && status)setLastSample(Date.now());},[connected,status]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer);},[]);
  const gyro=numbers(status?.gyro_dps),acc=numbers(status?.accel_g),angles=numbers(status?.attitude_deg);
  const fresh=connected && lastSample>0 && now-lastSample<2500 && !error;
  const valid=fresh && status?.gyro_ok==="yes";
  const hasAngles=valid && angles.length>=2;
  const roll=hasAngles?angles[0]:0,pitch=hasAngles?angles[1]:0;
  const magnitude=valid && acc.length===3?Math.hypot(...acc):null;
  const cell=(values:number[],i:number,digits:number)=>valid && values.length===3?values[i].toFixed(digits):"—";
  // Project a quad in body coordinates (x forward, y right, z down).
  const project=(x:number,y:number):[number,number]=>{
    const r=roll*Math.PI/180,p=pitch*Math.PI/180;
    const yy=y*Math.cos(r),z=y*Math.sin(r);
    const xx=x*Math.cos(p)+z*Math.sin(p),zz=-x*Math.sin(p)+z*Math.cos(p);
    return [240+yy*0.88,160-xx*0.58+zz*0.7];
  };
  const motors=[project(90,-90),project(90,90),project(-90,-90),project(-90,90)];
  const nose=project(115,0);
  return <div className="panel">
    <h2>Live sensors</h2>
    <p>Move the quad gently. Gyro measures rotation speed; acceleration includes gravity.</p>
    <p role="status" className={valid?"muted":"banner-warn"}>
      {!connected?"Connect the board to see live readings.":error?`Telemetry error: ${error}`:!fresh?"Waiting for fresh telemetry…":status?.gyro_ok!=="yes"?`Sensor not healthy (${status?.gyro_bind??"unknown"}).`:"Receiving live sensor data"}
    </p>
    <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{flex:"1 1 320px",maxWidth:520}}>
        <svg viewBox="0 0 480 300" role="img" aria-label={hasAngles?`Quad tilt: roll ${roll.toFixed(1)} degrees, pitch ${pitch.toFixed(1)} degrees`:"Quad orientation unavailable"} style={{width:"100%",background:"#101b2a",borderRadius:12}}>
          <path d="M40 160H440 M240 30V280" stroke="#334155" strokeDasharray="5 5"/>
          <text x="240" y="25" textAnchor="middle" fill="#94a3b8" fontSize="13">FRONT</text>
          {hasAngles?<g>
            {motors.map(([x,y],i)=><g key={i}><line x1="240" y1="160" x2={x} y2={y} stroke={i<2?"#38bdf8":"#94a3b8"} strokeWidth="10"/><ellipse cx={x} cy={y} rx="28" ry="16" fill="#172c40" stroke={i<2?"#38bdf8":"#94a3b8"} strokeWidth="3"/></g>)}
            <circle cx="240" cy="160" r="17" fill="#e2e8f0"/>
            <line x1="240" y1="160" x2={nose[0]} y2={nose[1]} stroke="#fb923c" strokeWidth="5"/>
            <circle cx={nose[0]} cy={nose[1]} r="7" fill="#fb923c"/>
          </g>:<text x="240" y="155" textAnchor="middle" fill="#cbd5e1">Orientation unavailable</text>}
        </svg>
        <p className="muted">Roll and pitch only; heading is not measured. Blue arms mark the front. View is illustrative—verify axis direction on the real quad.</p>
      </div>
      <div style={{flex:"1 1 260px"}}>
        <div className="status-grid">
          <div className="status-card"><div className="k">Roll</div><div className="v">{hasAngles?`${roll.toFixed(1)}°`:"—"}</div></div>
          <div className="status-card"><div className="k">Pitch</div><div className="v">{hasAngles?`${pitch.toFixed(1)}°`:"—"}</div></div>
          <div className="status-card"><div className="k">Total acceleration</div><div className="v">{magnitude!==null?`${magnitude.toFixed(3)} g`:"—"}</div></div>
          <div className="status-card"><div className="k">Gyro calibrated</div><div className="v">{fresh?status?.gyro_calibrated??"unavailable":"—"}</div></div>
        </div>
        <table style={{width:"100%",fontVariantNumeric:"tabular-nums"}}><thead><tr><th>Axis</th><th>Gyro °/s</th><th>Acceleration g</th></tr></thead><tbody>
          {["X / roll","Y / pitch","Z / yaw"].map((axis,i)=><tr key={axis}><td>{axis}</td><td>{cell(gyro,i,2)}</td><td>{cell(acc,i,3)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
    <h3>Gyro calibration</h3>
    <p>Set the quad down and keep it completely still. Start calibration, then wait for “Gyro calibrated” to show “yes”. Movement can restart the firmware’s calibration.</p>
    <button disabled={!valid||pending||status?.arm!=="disarmed"||gyro.length!==3} onClick={()=>void command("calibrate_gyro")}>{pending?"Sending calibration command…":"Calibrate gyro"}</button>
    {reply&&<p role="status">{reply}</p>}
    <p className="muted">At rest, rotation rates should be near zero and total acceleration near 1 g. This button calibrates gyro bias only; accelerometer offset calibration is not yet implemented.</p>
  </div>;
}
