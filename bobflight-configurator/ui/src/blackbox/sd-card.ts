/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import type {Link} from './recorder';
export const SD_COMMANDS=['sd probe','sd status','sd cancel'] as const;
export type SdCommand=typeof SD_COMMANDS[number];
const ACTIVE=['initializing','reading-mbr','reading-boot-sector'];
const STATES=['idle',...ACTIVE,'done','error','cancelled'];
export interface SdSnapshot {
 state:string; detail:string; capacityBytes:number|null; filesystem:string;
 partitionLba:number|null; clusterBytes:number|null; volumeFlags:number|null;
 ioError:number|null; unavailable:boolean; raw:string;
}
export function parseSdReply(raw:string):SdSnapshot {
 if(raw.length>8192)throw Error('SD reply exceeds the diagnostic size limit.');
 const blank={capacityBytes:null,filesystem:'unknown',partitionLba:null,clusterBytes:null,volumeFlags:null,ioError:null};
 if(/(^|\n)(unknown\b|sd unavailable:)/i.test(raw)||/sd_state: unavailable-mock/.test(raw))
  return {...blank,state:'unavailable',detail:raw.trim(),unavailable:true,raw};
 if(/(^|\n)sd refused:/.test(raw))throw Error(raw.split(/\r?\n/).find(x=>x.startsWith('sd refused:')));
 const fields:Record<string,string>={};
 for(const line of raw.split(/\r?\n/)){
  const match=/^(sd_[a-z_]+):\s*(.*?)\s*$/.exec(line);if(!match)continue;
  if(Object.hasOwn(fields,match[1]))throw Error('Duplicate field in SD reply.');
  fields[match[1]]=match[2];
 }
 if(fields.sd_end!=='1'||fields.sd_api!=='1'||!STATES.includes(fields.sd_state)||fields.sd_write_enabled!=='no'||fields.sd_filesystem_validated!=='no')
  throw Error('Incomplete or unsupported SD diagnostic reply. Firmware with sdprobe1 support is required.');
 const number=(key:string)=>{
  const text=fields[key];if(text===undefined)return null;
  if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('Invalid numeric field in SD reply.');
  return Number(text);
 };
 return {state:fields.sd_state,detail:fields.sd_detail||'',capacityBytes:number('sd_capacity_bytes'),filesystem:fields.sd_filesystem_hint||'unknown',partitionLba:number('sd_partition_lba'),clusterBytes:number('sd_cluster_bytes'),volumeFlags:number('sd_volume_flags'),ioError:number('sd_io_error'),unavailable:false,raw};
}
/** Explicit user start only; polling uses sd status, never retries initialization.
 * Hidden/disconnected/post-flash/bench-recording views invalidate pending replies. */
export class SdCardController {
 snapshot:SdSnapshot|null=null;
 error='';pending=false;polling=false;
 private enabled=false;private epoch=0;private started=0;private nextPoll=0;
 constructor(private link:Link,private now=()=>performance.now()){}
 get busy(){return this.pending||this.polling;}
 setEnabled(enabled:boolean){
  if(this.enabled===enabled)return;
  this.enabled=enabled;this.epoch++;this.polling=false;this.snapshot=null;this.error='';
 }
 async command(cmd:SdCommand){
  if(!this.enabled||this.pending||!SD_COMMANDS.includes(cmd)||this.link.getConnectionStatus()!=='connected')return false;
  if(cmd==='sd probe'&&this.polling)return false;
  const token=this.epoch;this.pending=true;this.error='';
  try{
   const raw=await this.link.sendCommand(cmd);
   if(!this.enabled||token!==this.epoch||this.link.getConnectionStatus()!=='connected')return false;
   const snapshot=parseSdReply(raw);this.snapshot=snapshot;
   const wasPolling=this.polling;this.polling=ACTIVE.includes(snapshot.state);
   if(this.polling&&!wasPolling)this.started=this.now();
   this.nextPoll=this.now()+1000;return true;
  }catch(e){
   if(this.enabled&&token===this.epoch){this.error=String(e).slice(0,1000);this.polling=false;}
   return false;
  }finally{this.pending=false;}
 }
 async tick(){
  if(!this.enabled||!this.polling||this.pending)return;
  if(this.link.getConnectionStatus()!=='connected'){this.setEnabled(false);return;}
  if(this.now()-this.started>=15000){this.polling=false;this.error='Status polling timed out. Refresh status or cancel the probe; initialization will not be retried automatically.';return;}
  if(this.now()>=this.nextPoll)await this.command('sd status');
 }
}
