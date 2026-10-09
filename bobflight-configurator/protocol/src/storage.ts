import {isSettingsKey,validateSettingValue,ACTUAL_RATE_KEYS} from "./settings";
/* SPDX-License-Identifier: Apache-2.0 */
import {snapshot,field,bit,uint,isModeRangeCommand} from './parse-modes';
export const STORAGE_SCOPE='pid_rates,receiver_uart,receiver_map,mode_ranges,control_selection,accel_calibration,power,dshot,min_throttle,airmode,gyro_lpf_hz,dterm_lpf_hz,pid_yaw_d,loop_rate_hz,gyro_notch1_hz,gyro_notch1_cutoff_hz,gyro_notch2_hz,gyro_notch2_cutoff_hz,rpm_filter_harmonics,rpm_filter_min_hz,rpm_filter_q_x100,motor_poles,motor_direction,align_board_roll,align_board_pitch,align_board_yaw,actual_rates';
export const STORAGE_SCOPE_V13=STORAGE_SCOPE;
export const STORAGE_PAYLOAD_BYTES_V13=256;
export const MOTOR_DIRECTION_EXPORT_TOKENS=['props-out','props-in'] as const;
export const CONFIG_EXPORT_MAX_BYTES=3072;
/** Schema 9 export domain of the RPM filter keys (FW config_rpm_value_valid). */
export function rpmExportValueValid(key:string,n:number):boolean{
 if(!Number.isInteger(n))return false;
 if(key==='rpm_filter_harmonics')return n>=0&&n<=3;
 if(key==='rpm_filter_min_hz')return n>=50&&n<=200;
 if(key==='rpm_filter_q_x100')return n>=100&&n<=1000;
 if(key==='motor_poles')return n>=4&&n<=36&&n%2===0;
 return false;
}
const scopeFor=(v:string|undefined)=>v==='13'?STORAGE_SCOPE_V13:undefined;
export interface StorageSnapshot {backend:'flash'|'host_sim'|'unsupported';schema:13;state:'saved'|'dirty'|'defaults'|'error'|'unsupported';dirty:boolean;generation:number;lastError:string;scope:string;armed:boolean;benchActive:boolean;calibrationActive:boolean;flightEnabled:boolean}
export function parseStorage(raw:string):StorageSnapshot {
 const {fields:f,rows}=snapshot(raw,'storage','unused');if(rows.length)throw Error('Unexpected storage rows');
 const backend=field(f,'backend'),state=field(f,'state'),dirty=bit(field(f,'dirty'));
 if(!['flash','host_sim','unsupported'].includes(backend)||!['saved','dirty','defaults','error','unsupported'].includes(state)||!(['13'].includes(field(f,'schema')))||field(f,'scope')!==scopeFor(field(f,'schema')))throw Error('Fresh install required: expected storage schema 13');
 if(state==='saved'&&dirty||state==='dirty'&&!dirty||backend==='unsupported'&&state!=='unsupported')throw Error('Contradictory storage state');
 const lastError=field(f,'last_error');if(!/^[a-z_]+$/.test(lastError)||state==='saved'&&lastError!=='none')throw Error('Invalid storage status');
 return {backend:backend as StorageSnapshot['backend'],schema:Number(field(f,'schema')) as 13,state:state as StorageSnapshot['state'],dirty,generation:uint(field(f,'generation'),0,4294967295),lastError,scope:field(f,'scope'),armed:bit(field(f,'armed')),benchActive:bit(field(f,'bench_active')),calibrationActive:bit(field(f,'calibration_active')),flightEnabled:bit(field(f,'flight_enabled'))};
}
export function isVerifiedFlashSave(raw:string):boolean{return raw.trim()==='saved: flash verified';}
export function canSaveStorage(s:StorageSnapshot|null,connected:boolean,pending:boolean):boolean{return connected&&!pending&&!!s&&s.backend==='flash'&&s.lastError!=='fresh_install_required'&&s.lastError!=='invalid_record'&&!s.armed&&!s.benchActive&&!s.calibrationActive;}
export interface ConfigurationExport {raw:string;board:string;firmware:string;kind:'diff'|'dump';modeCount:2|4}
export function parseConfigurationExport(raw:string,kind:'diff'|'dump'):ConfigurationExport {
 if(raw.length>CONFIG_EXPORT_MAX_BYTES)throw Error(`Configuration export is ${raw.length} bytes; the limit is ${CONFIG_EXPORT_MAX_BYTES} bytes`);
 const lines=raw.trim().split(/\r?\n/);if(lines[0]!=='# bobflight_config: 1'||lines.at(-1)!=='# config_end: 1')throw Error('Incomplete configuration export');
 const headers=new Map<string,string>();let commands=false;
 for(const line of lines.slice(1,-1)){
  if(line.startsWith('# ')){if(commands)throw Error('Misplaced export header');const m=/^# ([a-z_]+): (.+)$/.exec(line);if(!m||headers.has(m[1]))throw Error('Malformed export header');headers.set(m[1],m[2]);}
  else {commands=true;if(line.startsWith('power_config ')||line.startsWith('dshot ')){
    if(!['13'].includes(headers.get('schema')??''))throw Error('Unexpected power/motor setting');
    if(line.startsWith('dshot ')){if(!/^dshot (300|600)$/.test(line))throw Error('Invalid DShot rate');}
    else {const v=line.split(' ').slice(1).map(Number);if(v.length!==7||line.split(' ').slice(1).some(x=>!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/.test(x))||v.some(x=>!Number.isFinite(x))||v[0]<1||v[0]>30||v[1]<0||v[1]>1000||(v[1]>0&&v[1]<1)||v[2]<0||v[2]>3300||!Number.isInteger(v[3])||v[3]<0||v[3]>6||v[5]<2.5||v[4]>4.3||v[5]>=v[4]||!Number.isInteger(v[6])||v[6]<0||v[6]>50000)throw Error('Invalid power setting');}
    continue;
   }if(line.startsWith('set motor_direction ')){if(!['13'].includes(headers.get('schema')??'')||!/^set motor_direction (props-out|props-in)$/.test(line))throw Error('Invalid exported motor direction');continue;}
   if(!/^(set [a-z][a-z0-9_]* -?\d+(?:\.\d+)?(?:e[+-]?\d+)?|receiver_uart [123467]|receiver_map (AETR|TAER)|mode_range (ARM|ANGLE|ACRO|HORIZON) [01] (?:[1-9]|1[0-2]) \d+ \d+|control_mode (angle|acro|horizon)|control_source (manual|aux))$/.test(line))throw Error('Unsupported export command');
    if(line.startsWith('mode_range ')&&!isModeRangeCommand(line))throw Error('Invalid export range');
    if(line.startsWith('set loop_rate_hz ')){if(!['13'].includes(headers.get('schema')??'')||!/^set loop_rate_hz (1000|4000|8000)$/.test(line))throw Error('Invalid exported loop rate');continue;}
    if(/^set gyro_notch[12]_(?:cutoff_)?hz /.test(line)){const [,key,value]=line.split(' ');const n=Number(value);if(!['13'].includes(headers.get('schema')??'')||!Number.isFinite(n)||(key.endsWith('_cutoff_hz')?(n<0||n>=1000):(n!==0&&(n<20||n>1000))))throw Error('Invalid exported gyro notch');continue;}
    if(/^set (?:rpm_filter_(?:harmonics|min_hz|q_x100)|motor_poles) /.test(line)){const [,key,value]=line.split(' ');if(!['13'].includes(headers.get('schema')??'')||!/^\d+$/.test(value)||!rpmExportValueValid(key,Number(value)))throw Error('Invalid exported RPM filter setting');continue;}
    if(/^set align_board_(roll|pitch|yaw) /.test(line)){if(!['13'].includes(headers.get('schema')??'')||!isBoardAlignmentCommand(line))throw Error('Invalid exported board alignment');continue;}
    if(line.startsWith('set ')){
     const [,key,value]=line.split(' ');const n=Number(value);
     if((ACTUAL_RATE_KEYS as readonly string[]).includes(key)&&headers.get('schema')!=='13')throw Error('Fresh install required: schema 13 only');
     if(!isSettingsKey(key)||!validateSettingValue(key,n))throw Error('Invalid exported setting');
    }
  }
 }
 const board=headers.get('board')??'',firmware=headers.get('firmware')??'',count=headers.get('mode_count');
 const excludes='gyro_calibration';
 if(!['13'].includes(headers.get('schema')??'')||headers.get('kind')!==kind||headers.get('scope')!==scopeFor(headers.get('schema'))||headers.get('excludes')!==excludes||!['2','4'].includes(count??'')||!/^[-a-zA-Z0-9_]+$/.test(board)||!/^[-a-zA-Z0-9._+]+$/.test(firmware))throw Error('Unsupported export identity/schema');
 if(headers.get('schema')!=='1'){
  if(!['yes','no'].includes(headers.get('accel_calibrated')??'')||headers.get('calibration_restore')!=='metadata-only-recalibrate-if-flash-lost'||!['ram-only','error','not-calibrated','unsaved','flash-verified','host-sim'].includes(headers.get('accel_storage')??''))throw Error('Invalid calibration metadata');
  for(const key of ['accel_bias','accel_scale']){const parts=(headers.get(key)??'').split(' ');if(parts.length!==3||parts.some(v=>!v||!Number.isFinite(Number(v))))throw Error('Invalid calibration vector');const v=parts.map(Number);if(key==='accel_bias'?Math.hypot(...v)>0.300001:v.some(x=>x<0.9||x>1.1))throw Error('Invalid calibration bounds');}
 }
 return {raw,board,firmware,kind,modeCount:Number(count) as 2|4};
}

/** Separate optional capability: do not bulk-query old firmware for these keys. */
export function isBoardAlignmentCommand(cmd:string):boolean{
 if(/^get align_board_(roll|pitch|yaw)$/.test(cmd))return true;
 const m=/^set align_board_(roll|pitch|yaw) (-?(?:0|[1-9]\d{0,2}))$/.exec(cmd);
 return !!m && Math.abs(Number(m[2]))<=180;
}
