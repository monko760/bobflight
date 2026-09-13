import {useEffect,useMemo,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {Recorder,QUERIES,csv,type Query} from '../blackbox/recorder';

export function BlackboxPage({visible}:{visible:boolean}) {
  const {host,connectionStatus,postFlashGate}=useHost();
  const recorder=useMemo(()=>new Recorder(host),[host]);
  const [,render]=useState(0);
  const [queries,setQueries]=useState<Query[]>([...QUERIES]);
  const [replace,setReplace]=useState(false);
  const update=()=>render(n=>n+1);
  useEffect(()=>{
    if(!visible || postFlashGate || connectionStatus!=='connected'){recorder.stop(!visible?'left-tab':'disconnected');update();}
    if(!visible)return;
    const timer=setInterval(()=>{void recorder.tick().then(update);},200);
    return ()=>{clearInterval(timer);};
  },[recorder,visible,connectionStatus,postFlashGate]);
  useEffect(()=>{
    const warn=(e:BeforeUnloadEvent)=>{if(recorder.log.samples.length){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[recorder]);
  useEffect(()=>()=>recorder.stop('page-closed'),[recorder]);
  function download(kind:'json'|'csv'){
    const data=kind==='json'?JSON.stringify(recorder.log,null,2):csv(recorder.log);
    const url=URL.createObjectURL(new Blob([data],{type:kind==='json'?'application/json':'text/csv'}));
    const a=document.createElement('a');a.href=url;a.download=`bobflight-bench-${recorder.log.started.replace(/[:.]/g,'-')}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section hidden={!visible} className="panel">
    <h2>Blackbox · USB bench recorder</h2>
    <p>Record sensor, receiver, power and status replies on this computer. Remove propellers for bench work. Recording only reads data; it does not start motors or PID diagnostics.</p>
    <p>Up to five requests per second, shared between the selected sources. Each reply has its own timestamp; this is not a high-speed flight log or Blackbox Explorer file. PID values are available only during a separately started diagnostic session; inactive and unsupported replies are retained as reported.</p>
    <fieldset disabled={recorder.active}><legend>Data sources</legend>{QUERIES.map(q=><label key={q} style={{display:'block'}}><input type="checkbox" checked={queries.includes(q)} onChange={e=>setQueries(e.target.checked?[...queries,q]:queries.filter(x=>x!==q))}/>{q}</label>)}</fieldset>
    {!!recorder.log.samples.length&&!recorder.active&&<label style={{display:'block'}}><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>Replace this recording when starting a new one (download it first).</label>}
    <p><button disabled={recorder.active||connectionStatus!=='connected'||postFlashGate||!queries.length||(!!recorder.log.samples.length&&!replace)} onClick={()=>{recorder.start(queries);setReplace(false);update();}}>Start recording</button>{' '}
    <button disabled={!recorder.active} onClick={()=>{recorder.stop();update();}}>Stop recording</button>{' '}
    <button disabled={recorder.active||!recorder.log.samples.length} onClick={()=>download('json')}>Download JSON</button>{' '}
    <button disabled={recorder.active||!recorder.log.samples.length} onClick={()=>download('csv')}>Download CSV</button></p>
    <p role="status">{recorder.active?'Recording':recorder.log.reason} · {recorder.log.samples.length} replies captured</p>
    <p>Recording stops when you leave this tab, lose the connection, or reach ten minutes / the memory limit. Captured data stays here across tab changes; download it before refreshing or closing the page. Demo connections contain simulated data.</p>
    <details><summary>Latest reply</summary><pre style={{whiteSpace:'pre-wrap'}}>{recorder.log.samples.at(-1)?.raw||recorder.log.samples.at(-1)?.error||'No samples yet.'}</pre></details>
  </section>;
}
