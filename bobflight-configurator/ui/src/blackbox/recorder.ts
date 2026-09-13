/* SPDX-License-Identifier: Apache-2.0 */
import type {CliCommand} from '../protocol';
export const QUERIES = ['sensors', 'receiver', 'power', 'status', 'pid_diag status'] as const;
export type Query = typeof QUERIES[number];
export interface Sample { command: string; requested_ms: number; received_ms: number; raw: string; error?: string }
export interface Recording {
  format: 'bobflight-usb-bench'; schema: 1; started: string; reason: string;
  timing: string; samples: Sample[];
}
export interface Link { sendCommand(command: CliCommand): Promise<string>; getConnectionStatus(): string }
/** One request at a time. No retries or controller writes; time is browser monotonic time. */
export class Recorder {
  log: Recording = this.empty();
  active = false;
  private pending = false;
  private epoch = 0;
  private startTime = 0;
  private bytes = 0;
  private index = 0;
  private queries: readonly Query[] = QUERIES;
  constructor(private link: Link, private now = () => performance.now()) {}
  private empty(): Recording { return {format:'bobflight-usb-bench',schema:1,started:'',reason:'not-started',timing:'Browser request/receive milliseconds; asynchronous snapshots, not a flight-rate stream.',samples:[]}; }
  start(queries: readonly Query[]) {
    if(this.active || this.pending || this.link.getConnectionStatus() !== 'connected' || !queries.length || queries.some(q=>!QUERIES.includes(q))) return false;
    this.log=this.empty();this.log.started=new Date().toISOString();this.log.reason='recording';
    this.active=true;this.startTime=this.now();this.bytes=0;this.index=0;this.queries=[...queries];this.epoch++;
    return true;
  }
  stop(reason='user-stop') { if(this.active){this.active=false;this.log.reason=reason;this.epoch++;} }
  async tick() {
    if(!this.active || this.pending)return;
    if(this.link.getConnectionStatus()!=='connected'){this.stop('disconnected');return;}
    if(this.now()-this.startTime>=600000){this.stop('ten-minute-limit');return;}
    if(this.log.samples.length>=5000){this.stop('sample-limit');return;}
    const token=this.epoch;
    const command=this.index++===0?'version':this.queries[(this.index-2)%this.queries.length];
    const requested_ms=this.now()-this.startTime;
    this.pending=true;
    try {
      const raw=await this.link.sendCommand(command);
      if(!this.active||token!==this.epoch)return;
      if(this.link.getConnectionStatus()!=='connected'){this.stop('disconnected');return;}
      if(this.bytes+raw.length*2>8*1024*1024){this.stop('memory-limit');return;}
      this.bytes+=raw.length*2;
      this.log.samples.push({command,requested_ms,received_ms:this.now()-this.startTime,raw});
    } catch(e) {
      if(this.active&&token===this.epoch){this.log.samples.push({command,requested_ms,received_ms:this.now()-this.startTime,raw:'',error:String(e).slice(0,1000)});this.stop('request-failed');}
    } finally {this.pending=false;}
  }
}
// Quote every cell and neutralize spreadsheet formulas in text from the device.
function cell(v: string|number) { const s=String(v);return '"'+(/^[\s]*[=+@-]/.test(s)&&typeof v==='string'?"'":'')+s.replace(/"/g,'""')+'"'; }
export function csv(log: Recording): string {
  const rows: (string|number)[][]=[['command','requested_ms','received_ms','field','value']];
  for(const s of log.samples){
    if(s.error)rows.push([s.command,s.requested_ms,s.received_ms,'error',s.error]);
    for(const line of s.raw.split(/\r?\n/).filter(Boolean)){
      const i=line.indexOf(':');rows.push([s.command,s.requested_ms,s.received_ms,i<0?'reply':line.slice(0,i),i<0?line:line.slice(i+1).trim()]);
    }
  }
  return rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
