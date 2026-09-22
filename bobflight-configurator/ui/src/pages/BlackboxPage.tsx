import {useEffect,useMemo,useState} from 'react';
import {useHost} from '../hooks/useHost';
import {Recorder,QUERIES,csv,type Query} from '../blackbox/recorder';
import {SdCardController,type SdCommand} from '../blackbox/sd-card';

export function BlackboxPage({visible}:{visible:boolean}) {
  const {host,connectionStatus,postFlashGate}=useHost();
  const recorder=useMemo(()=>new Recorder(host),[host]);
  const sd=useMemo(()=>new SdCardController(host),[host]);
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
  const sdEnabled=visible&&connectionStatus==='connected'&&!postFlashGate&&!recorder.active;
  useEffect(()=>{
    sd.setEnabled(sdEnabled);update();
    if(!sdEnabled)return;
    const timer=setInterval(()=>{void sd.tick().then(update);},1000);
    return()=>{clearInterval(timer);sd.setEnabled(false);};
  },[sd,sdEnabled]);
  function sdCommand(command:SdCommand){const request=sd.command(command);update();void request.then(update);}
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
    <h2>Blackbox</h2>
    <section aria-labelledby="sd-card-title">
      <h3 id="sd-card-title">Onboard SD card</h3>
      <p>Check the card installed in the flight controller. This is a read-only diagnostic: it does not format, mount, repair or write to the card. Remove propellers, disarm, and stop motor tests and calibration first.</p>
      <p><button disabled={!sdEnabled||sd.busy} onClick={()=>sdCommand('sd probe')}>Check SD card</button>{' '}
      <button disabled={!sdEnabled||sd.pending} onClick={()=>sdCommand('sd status')}>Refresh status</button>{' '}
      <button disabled={!sdEnabled||sd.pending} onClick={()=>sdCommand('sd cancel')}>Cancel probe</button></p>
      {recorder.active&&<p>Stop the USB bench recording before checking the SD card.</p>}
      {postFlashGate&&<p>Complete the post-flash connection checks before using SD diagnostics.</p>}
      <p role="status" aria-live="polite">{connectionStatus!=='connected'?'Connect to the controller to check its SD card.':sd.pending?'Reading controller reply…':sd.polling?'Checking card; refreshing status once per second…':sd.snapshot?`Last probe state: ${sd.snapshot.state}`:'No card check requested on this connection.'}</p>
      {!!sd.error&&<p role="alert">{sd.error}</p>}
      {sd.snapshot&&!sd.snapshot.unavailable&&<dl>
        <dt>Reported capacity</dt><dd>{sd.snapshot.capacityBytes ? `${(sd.snapshot.capacityBytes/1e9).toFixed(2)} GB (${sd.snapshot.capacityBytes.toLocaleString()} bytes)` : 'Not established'}</dd>
        <dt>Filesystem hint</dt><dd>{sd.snapshot.filesystem} (not mounted or fully validated)</dd>
        <dt>Partition start</dt><dd>{sd.snapshot.partitionLba===null?'Not reported':`${sd.snapshot.partitionLba} sectors`}</dd>
        <dt>Cluster size</dt><dd>{sd.snapshot.clusterBytes ? `${sd.snapshot.clusterBytes.toLocaleString()} bytes`:'Not established'}</dd>
        <dt>Diagnostic detail</dt><dd>{sd.snapshot.detail||'Not reported'}</dd>
        <dt>Card I/O error code</dt><dd>{sd.snapshot.ioError??'Not reported'}</dd>
      </dl>}
      {sd.snapshot?.unavailable&&<p>SD diagnostics are unavailable on this connection. Demo mode does not simulate a working card; older firmware may not support the commands.</p>}
      <p><strong>Flight-log files are not available yet.</strong> The firmware does not yet create onboard <code>.bbl</code> files or provide file downloads. USB removable-drive mode is also not implemented. The JSON/CSV downloads below are different, low-rate USB bench recordings.</p>
      <button disabled title="Requires onboard log-file creation and a file-transfer API">Download .bbl (not yet available)</button>
      {sd.snapshot&&<details><summary>SD diagnostic reply</summary><pre style={{whiteSpace:'pre-wrap'}}>{sd.snapshot.raw}</pre></details>}
    </section>
    <hr/>
    <h3>USB bench recorder (JSON / CSV)</h3>
    <p>Record sensor, receiver, power and status replies on this computer. Remove propellers for bench work. Recording only reads data; it does not start motors or PID diagnostics.</p>
    <p>Up to five requests per second, shared between the selected sources. Each reply has its own timestamp; this is not a high-speed flight log or Blackbox Explorer file. PID values are available only during a separately started diagnostic session; inactive and unsupported replies are retained as reported.</p>
    <fieldset disabled={recorder.active}><legend>Data sources</legend>{QUERIES.map(q=><label key={q} style={{display:'block'}}><input type="checkbox" checked={queries.includes(q)} onChange={e=>setQueries(e.target.checked?[...queries,q]:queries.filter(x=>x!==q))}/>{q}</label>)}</fieldset>
    {!!recorder.log.samples.length&&!recorder.active&&<label style={{display:'block'}}><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>Replace this recording when starting a new one (download it first).</label>}
    <p><button disabled={sd.busy||recorder.active||connectionStatus!=='connected'||postFlashGate||!queries.length||(!!recorder.log.samples.length&&!replace)} onClick={()=>{recorder.start(queries);setReplace(false);update();}}>Start recording</button>{' '}
    <button disabled={!recorder.active} onClick={()=>{recorder.stop();update();}}>Stop recording</button>{' '}
    <button disabled={recorder.active||!recorder.log.samples.length} onClick={()=>download('json')}>Download JSON</button>{' '}
    <button disabled={recorder.active||!recorder.log.samples.length} onClick={()=>download('csv')}>Download CSV</button></p>
    <p role="status">{recorder.active?'Recording':recorder.log.reason} · {recorder.log.samples.length} replies captured</p>
    <p>Recording stops when you leave this tab, lose the connection, or reach ten minutes / the memory limit. Captured data stays here across tab changes; download it before refreshing or closing the page. Demo connections contain simulated data.</p>
    <details><summary>Latest reply</summary><pre style={{whiteSpace:'pre-wrap'}}>{recorder.log.samples.at(-1)?.raw||recorder.log.samples.at(-1)?.error||'No samples yet.'}</pre></details>
  </section>;
}
