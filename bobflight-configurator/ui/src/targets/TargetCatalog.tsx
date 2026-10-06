// Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { boardsForFamily, catalog, families, type TargetFamily } from './catalog';
export function TargetCatalog() {
  const [family,setFamily] = useState<TargetFamily>('F7');
  const boards=boardsForFamily(family);
  return <details className="panel" style={{marginBottom:'1rem'}}>
    <summary>F4 / F7 / H7 target catalog</summary>
    <p className="muted">From the firmware's board definitions. This catalog is informational; choose the actual flash target below. An implemented backend is not hardware or flight qualification.</p>
    <label>Browse MCU family <select value={family} onChange={e=>setFamily(e.target.value as TargetFamily)}>{families.map(f=><option key={f}>{f}</option>)}</select></label>
    <ul>{catalog.mcus.filter(m=>m.family===family).map(m=><li key={m.id}><strong>{m.part}</strong>: {m.status==='implemented'?'backend present; board capabilities vary':'planned, not buildable or flashable'}</li>)}</ul>
    {boards.length===0 ? <p>No implemented board definitions for this family yet.</p> : boards.map(b=><div key={b.id}>
      <h4>{b.display_name}</h4><code>{b.id}</code><p>{b.support}. Motor output: {b.capabilities.motor_output?'implemented':'unavailable'}; USB CDC: {b.capabilities.usb_cdc?'implemented':'unavailable'}; SD logging: {b.capabilities.sd_logging?'implemented':'unavailable'}.</p>
    </div>)}
    <p className="muted">Aircraft mounting rotation, motor ordering, PID settings and saved setup remain separate from hardware definitions. No automatic firmware download or profile upload is performed here.</p>
  </details>;
}
