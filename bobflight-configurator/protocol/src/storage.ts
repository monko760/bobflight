import {isSettingsKey} from "./settings";
/* SPDX-License-Identifier: Apache-2.0 */
import {snapshot,field,bit,uint,isModeRangeCommand} from './parse-modes';
export const STORAGE_SCOPE='pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection';
export const STORAGE_SCOPE_V2=STORAGE_SCOPE+',accel_calibration';
export const STORAGE_SCOPE_V3=STORAGE_SCOPE_V2+',power,dshot';
const scopeFor=(v:string|undefined)=>v==='3'?STORAGE_SCOPE_V3:v==='2'?STORAGE_SCOPE_V2:STORAGE_SCOPE;
export interface StorageSnapshot {backend:'flash'|'host_sim'|'unsupported';schema:1|2|3;state:'saved'|'dirty'|'defaults'|'error'|'unsupported';dirty:boolean;generation:number;lastError:string;scope:string;armed:boolean;benchActive:boolean;calibrationActive:boolean;flightEnabled:boolean}
export function parseStorage(raw:string):StorageSnapshot {
 const {fields:f,rows}=snapshot(raw,'storage','unused');if(rows.length)throw Error('Unexpected storage rows');
 const backend=field(f,'backend'),state=field(f,'state'),dirty=bit(field(f,'dirty'));
 if(!['flash','host_sim','unsupported'].includes(backend)||!['saved','dirty','defaults','error','unsupported'].includes(state)||!(['1','2','3'].includes(field(f,'schema')))||field(f,'scope')!==scopeFor(field(f,'schema')))throw Error('Unsupported storage capability/schema');
 if(state==='saved'&&dirty||state==='dirty'&&!dirty||backend==='unsupported'&&state!=='unsupported')throw Error('Contradictory storage state');
 const lastError=field(f,'last_error');if(!/^[a-z_]+$/.test(lastError)||state==='saved'&&lastError!=='none')throw Error('Invalid storage status');
 return {backend:backend as StorageSnapshot['backend'],schema:Number(field(f,'schema')) as 1|2|3,state:state as StorageSnapshot['state'],dirty,generation:uint(field(f,'generation'),0,4294967295),lastError,scope:field(f,'scope'),armed:bit(field(f,'armed')),benchActive:bit(field(f,'bench_active')),calibrationActive:bit(field(f,'calibration_active')),flightEnabled:bit(field(f,'flight_enabled'))};
}
export function isVerifiedFlashSave(raw:string):boolean{return raw.trim()==='saved: flash verified';}
export function canSaveStorage(s:StorageSnapshot|null,connected:boolean,pending:boolean):boolean{return connected&&!pending&&!!s&&s.backend==='flash'&&!s.armed&&!s.benchActive&&!s.calibrationActive;}
export interface ConfigurationExport {raw:string;board:string;firmware:string;kind:'diff'|'dump';modeCount:2|4}
export function parseConfigurationExport(raw:string,kind:'diff'|'dump'):ConfigurationExport {
 const lines=raw.trim().split(/\r?\n/);if(raw.length>1800||lines[0]!=='# bobflight_config: 1'||lines.at(-1)!=='# config_end: 1')throw Error('Incomplete or oversized configuration export');
 const headers=new Map<string,string>();let commands=false;
 for(const line of lines.slice(1,-1)){
  if(line.startsWith('# ')){if(commands)throw Error('Misplaced export header');const m=/^# ([a-z_]+): (.+)$/.exec(line);if(!m||headers.has(m[1]))throw Error('Malformed export header');headers.set(m[1],m[2]);}
  else {commands=true;if(line.startsWith('power_config ')||line.startsWith('dshot ')){
    if(headers.get('schema')!=='3')throw Error('Unexpected power/motor setting');
    if(line.startsWith('dshot ')){if(!/^dshot (300|600)$/.test(line))throw Error('Invalid DShot rate');}
    else {const v=line.split(' ').slice(1).map(Number);if(v.length!==7||line.split(' ').slice(1).some(x=>!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/.test(x))||v.some(x=>!Number.isFinite(x))||v[0]<1||v[0]>30||v[1]<0||v[1]>1000||(v[1]>0&&v[1]<1)||v[2]<0||v[2]>3300||!Number.isInteger(v[3])||v[3]<0||v[3]>6||v[5]<2.5||v[4]>4.3||v[5]>=v[4]||!Number.isInteger(v[6])||v[6]<0||v[6]>50000)throw Error('Invalid power setting');}
    continue;
   }if(!/^(set [a-z_]+ -?\d+(?:\.\d+)?(?:e[+-]?\d+)?|receiver_uart [123467]|receiver_map (AETR|TAER)|mode_range (ARM|ANGLE|ACRO|HORIZON) [01] (?:[1-9]|1[0-2]) \d+ \d+|control_mode (angle|acro|horizon)|control_source (manual|aux))$/.test(line))throw Error('Unsupported export command');
    if(line.startsWith('mode_range ')&&!isModeRangeCommand(line))throw Error('Invalid export range');
    if(line.startsWith('set ')){const [,key,value]=line.split(' ');const n=Number(value);if(!isSettingsKey(key)||!Number.isFinite(n)||(key.startsWith('rate_max_')?(n<10||n>2000):key==='rate_expo'?(n<0||n>1):(n<0||n>10)))throw Error('Invalid exported setting');}
  }
 }
 const board=headers.get('board')??'',firmware=headers.get('firmware')??'',count=headers.get('mode_count');
 if(!['1','2','3'].includes(headers.get('schema')??'')||headers.get('kind')!==kind||headers.get('scope')!==scopeFor(headers.get('schema'))||headers.get('excludes')!==(headers.get('schema')==='3'?'gyro_calibration':headers.get('schema')==='2'?'gyro_calibration,power,dshot':'calibration,power,dshot')||!['2','4'].includes(count??'')||!/^[-a-zA-Z0-9_]+$/.test(board)||!/^[-a-zA-Z0-9._+]+$/.test(firmware))throw Error('Unsupported export identity/schema');
 if(headers.get('schema')!=='1'){
  if(!['yes','no'].includes(headers.get('accel_calibrated')??'')||headers.get('calibration_restore')!=='metadata-only-recalibrate-if-flash-lost'||!['ram-only','error','not-calibrated','unsaved','flash-verified','host-sim'].includes(headers.get('accel_storage')??''))throw Error('Invalid calibration metadata');
  for(const key of ['accel_bias','accel_scale']){
   const parts=(headers.get(key)??'').split(' ');
   if(parts.length!==3||parts.some(v=>!v||!Number.isFinite(Number(v))))throw Error('Invalid calibration vector');
   const v=parts.map(Number);
   if(key==='accel_bias'?Math.hypot(...v)>0.300001:v.some(x=>x<0.9||x>1.1))throw Error('Invalid calibration bounds');
  }
 }
 return {raw,board,firmware,kind,modeCount:Number(count) as 2|4};
}
