/* SPDX-License-Identifier: Apache-2.0 */
import {aircraftProjection, QUADX_MOTORS} from '../sensors/aircraftView';

type Props={roll:number;pitch:number;yaw:number;ready:boolean};
export function AircraftAttitudeView({roll,pitch,yaw,ready}:Props){
  const valid=ready&&[roll,pitch,yaw].every(Number.isFinite);
  const project=aircraftProjection(valid?roll:0,valid?pitch:0,valid?yaw:0);
  const front=project(145,0),back=project(-145,0);
  const motors=QUADX_MOTORS.map(m=>({...m,point:project(m.x,m.y)}));
  const points=(p:[number,number][])=>p.map(v=>v.join(',')).join(' ');
  // Keep all six labels upright and separate even in an edge-on view.
  const used:[number,number][]=[];
  const place=([x,y]:[number,number]):[number,number]=>{
    for(const [dx,dy] of [[0,0],[0,-32],[0,32],[-64,0],[64,0],[-64,-32],[64,32],[0,-64],[0,64]]){
      const q:[number,number]=[Math.max(34,Math.min(446,x+dx)),Math.max(18,Math.min(302,y+dy))];
      if(used.every(p=>Math.abs(p[0]-q[0])>=64||Math.abs(p[1]-q[1])>=30)){used.push(q);return q;}
    }
    const q:[number,number]=[34+used.length*64,302];used.push(q);return q;
  };
  const labels=[{text:'FRONT',point:front,key:'front',accent:true},{text:'BACK',point:back,key:'back',accent:false},
    ...motors.map(m=>({text:`M${m.number}`,point:m.point,key:`motor-${m.number}`,accent:m.front}))]
    .map(label=>({...label,label:place(label.point)}));
  return <svg viewBox="0 0 480 320" role="img" aria-label="Aircraft orientation with numbered QUADX motors and front and back markers"
    data-aircraft-view="true" data-attitude-ready={valid} style={{width:'100%',background:'#101923',borderRadius:10,border:'1px solid #334155'}}>
    <title>Aircraft orientation. M1 rear-right, M2 front-right, M3 rear-left, M4 front-left.</title>
    {!valid?<text x="240" y="160" textAnchor="middle" fill="#cbd5e1" fontSize="13">Orientation unavailable. Waiting for fresh telemetry.</text>:<g>
      {motors.map(m=><g key={m.number} data-motor={m.number} data-position={m.position}>
        <line x1="240" y1="160" x2={m.point[0]} y2={m.point[1]} stroke={m.front?'#38bdf8':'#94a3b8'} strokeWidth="10" strokeLinecap="round"/>
        <ellipse cx={m.point[0]} cy={m.point[1]} rx="27" ry="20" fill="#172c40" stroke={m.front?'#38bdf8':'#94a3b8'} strokeWidth="3"/>
      </g>)}
      <polygon points={points([project(45,0),project(18,-23),project(-30,-23),project(-30,23),project(18,23)])} fill="#dce7f1" stroke="#0f172a" strokeWidth="2"/>
      <line x1="240" y1="160" x2={front[0]} y2={front[1]} stroke="#38bdf8" strokeWidth="4"/>
      <polygon points={points([project(122,0),project(100,-12),project(100,12)])} fill="#38bdf8"/>
      <line x1="240" y1="160" x2={back[0]} y2={back[1]} stroke="#94a3b8" strokeWidth="3" strokeDasharray="5 4"/>
      {labels.map(l=><g key={l.key} data-label={l.key}>
        <line x1={l.point[0]} y1={l.point[1]} x2={l.label[0]} y2={l.label[1]} stroke={l.accent?'#38bdf8':'#94a3b8'} strokeWidth="1.5"/>
        <rect x={l.label[0]-30} y={l.label[1]-12} width="60" height="24" rx="5" fill="#101923" stroke={l.accent?'#38bdf8':'#94a3b8'}/>
        <text x={l.label[0]} y={l.label[1]+5} fill="#f1f5f9" textAnchor="middle" fontSize="14" fontWeight="700">{l.text}</text>
      </g>)}
    </g>}
  </svg>;
}
