import {useEffect,useState} from 'react';
import {parsePorts,type CliCommand} from '../protocol';
import {useConfigSnapshot} from './useConfigSnapshot';
export function PortsPage(){
 const q=useConfigSnapshot('ports',parsePorts),s=q.snapshot;const [uart,setUart]=useState<number|null>(null),[reply,setReply]=useState('');
 useEffect(()=>{setUart(s?.receiverUart??null);},[s]);
 const editable=q.connected&&!!s&&!s.armed&&!s.benchActive&&!q.pending;
 async function apply(){if(!editable||uart===null||!s?.ports.some(p=>p.id===uart&&p.selectable))return;const next=await q.execute(`receiver_uart ${uart}` as CliCommand,v=>{if(v.receiverUart!==uart)throw Error('UART readback does not match request');});if(next)setReply('UART applied and read back. Verify receiver controls. Reboot restores defaults.');}
 return <div className="panel"><h2>Ports</h2><p>Remove propellers. USB remains the CLI connection; this version supports only the advertised CRSF receiver UARTs.</p>
 {!q.connected&&<p className="banner-warn">Connect your board first.</p>}{q.error&&<p role="alert" className="fail">{q.error}</p>}
 <button disabled={!q.connected||q.pending} onClick={()=>void q.execute()}>Refresh ports</button>
 {s&&<><p>{s.board} {s.source==='mock'?'— DEMO, no physical UARTs':''}</p><p>Last snapshot: {new Date(q.loadedAt).toLocaleTimeString()}. Armed: {s.armed?'yes':'no'}; motor bench: {s.benchActive?'active':'inactive'}.</p>
 <table><thead><tr><th>Port</th><th>TX pin</th><th>RX pin</th><th>Role</th></tr></thead><tbody>{s.ports.map(p=><tr key={p.id}><td>{p.label}</td><td>{p.txPin}</td><td>{p.rxPin}</td><td>{p.role}</td></tr>)}</tbody></table>
 <p><label>CRSF receiver UART <select aria-label="CRSF receiver UART" disabled={!editable} value={uart??0} onChange={e=>setUart(Number(e.target.value))}><option value={0} disabled>No receiver UART</option>{s.ports.filter(p=>p.id!==0).map(p=><option key={p.id} value={p.id} disabled={!p.selectable}>{p.label}</option>)}</select></label>{' '}<button disabled={!editable||uart===null||!s.ports.some(p=>p.id===uart&&p.selectable)} onClick={()=>void apply()}>Apply UART until reboot</button></p></>}
 <p>Session-only settings. Ordinary Save does not persist this assignment. GPS, MSP, VTX and telemetry roles are not implemented.</p>{reply&&<p role="status">{reply}</p>}</div>;
}
