/* SPDX-License-Identifier: Apache-2.0 */
import type { CliCommand } from './types';
export type ControlMode='angle'|'acro'|'horizon';
export interface ModeRow {name:'ARM'|'ANGLE'|'ACRO'|'HORIZON';enabled:boolean;aux:number;minUs:number;maxUs:number;active:boolean}
/** N1 leveled-mode rate fallback (frozen; a new reason or state value is a contract change). */
export type LevelFallbackReason='none'|'attitude-invalid'|'failsafe-gravity-unqualified';
export type AttitudeState='valid'|'uninitialized'|'accel-invalid'|'gravity-timeout'|'recovering';
export const LEVEL_FALLBACK_REASONS:readonly LevelFallbackReason[]=['none','attitude-invalid','failsafe-gravity-unqualified'];
export const ATTITUDE_STATES:readonly AttitudeState[]=['valid','uninitialized','accel-invalid','gravity-timeout','recovering'];
/** Present only when the firmware reports all four keys; older firmware and the offline mock omit them. */
export interface LevelFallbackStatus {active:boolean;reason:LevelFallbackReason;count:number;attitudeState:AttitudeState}
const LEVEL_FALLBACK_KEYS=['level_fallback','level_fallback_reason','level_fallback_count','attitude_state'];
export function parseLevelFallback(f:Map<string,string>,effective:ControlMode):LevelFallbackStatus|undefined{
 const present=LEVEL_FALLBACK_KEYS.filter(k=>f.has(k));
 if(present.length===0)return undefined;
 if(present.length!==LEVEL_FALLBACK_KEYS.length)throw Error('Incomplete level fallback report');
 const active=bit(field(f,'level_fallback')),reason=field(f,'level_fallback_reason'),attitudeState=field(f,'attitude_state');
 if(!(LEVEL_FALLBACK_REASONS as readonly string[]).includes(reason))throw Error('Invalid level fallback reason');
 if(!(ATTITUDE_STATES as readonly string[]).includes(attitudeState))throw Error('Invalid attitude state');
 if(active!==(reason!=='none'))throw Error('Contradictory level fallback indication');
 if(active&&effective!=='acro')throw Error('Level fallback must fly rate (acro) control');
 const count=uint(field(f,'level_fallback_count'),0,4294967295);
 return {active,reason:reason as LevelFallbackReason,count,attitudeState:attitudeState as AttitudeState};
}
export interface ParsedModes {raw:string;levelFallback?:LevelFallbackStatus;apiVersion:1|2;calibrationActive:boolean;controlSource?:'manual'|'aux';requestedMode?:ControlMode;effectiveMode?:ControlMode;modeConflict?:boolean;armSemantics?:'preview'|'configured'; persistence:'session'|'flash';semantics:'control'|'preview'|'bench-control';flightEnabled:boolean;armed:boolean;benchActive:boolean;rxFresh:boolean;modes:ModeRow[];channels?:number[];source?:string}
export function uint(s:string,lo:number,hi:number):number {if(!/^(0|[1-9]\d*)$/.test(s))throw Error('Expected canonical unsigned integer');const n=Number(s);if(!Number.isSafeInteger(n)||n<lo||n>hi)throw Error('Integer outside supported bounds');return n;}
export function bit(s:string):boolean {return uint(s,0,1)===1;}
export function snapshot(raw:string,kind:string,rowKey:string,versions:number[]=[1]):{fields:Map<string,string>;rows:string[];apiVersion:number} {
 const lines=raw.trim().split(/\r?\n/);const apiVersion=versions.find(v=>lines[0]===`${kind}_api: ${v}`);if(apiVersion===undefined||lines.at(-1)!==`${kind}_end: 1`)throw Error(`Unsupported or incomplete ${kind} response`);
 const fields=new Map<string,string>(),rows:string[]=[];
 for(const line of lines.slice(1,-1)){const m=/^([a-z_]+): (.*)$/.exec(line);if(!m)throw Error('Malformed snapshot line');if(m[1]===rowKey){rows.push(m[2]);continue;}if(fields.has(m[1])||m[1]===`${kind}_api`||m[1]===`${kind}_end`)throw Error('Duplicate snapshot field');fields.set(m[1],m[2]);}
 return {fields,rows,apiVersion};
}
export function field(f:Map<string,string>,key:string):string{const x=f.get(key);if(x===undefined)throw Error(`Missing ${key}`);return x;}
export function parseModes(raw:string):ParsedModes {
 const {fields:f,rows,apiVersion}=snapshot(raw,'modes','mode',[1,2]);
 if(!['session','flash'].includes(field(f,'persistence')))throw Error('Unsupported persistence');
 const semantics=field(f,'semantics');
 if(apiVersion===2 ? semantics!=='bench-control' : semantics!=='control'&&semantics!=='preview')throw Error('Unsupported mode semantics');
 const rxFresh=bit(field(f,'rx_fresh'));
 const names=apiVersion===2?['ARM','ANGLE','ACRO','HORIZON']:['ARM','ANGLE'];
 const modes:ModeRow[]=rows.map(r=>{
  const a=r.split(',');if(a.length!==6||!names.includes(a[0]))throw Error('Invalid mode row');
  const enabled=bit(a[1]),aux=uint(a[2],1,12),minUs=uint(a[3],900,2100),maxUs=uint(a[4],900,2100),active=bit(a[5]);
  if(minUs>=maxUs||active&&(!rxFresh||!enabled))throw Error('Contradictory mode row');
  return {name:a[0] as ModeRow['name'],enabled,aux,minUs,maxUs,active};
 });
 if(modes.length!==names.length||new Set(modes.map(m=>m.name)).size!==names.length)throw Error('Expected exactly one of each supported mode');
 let channels:number[]|undefined;if(f.has('channels')){channels=field(f,'channels').split(',').map(v=>uint(v,900,2100));if(channels.length!==16)throw Error('Expected 16 channels');}
 const base:ParsedModes={raw,apiVersion:apiVersion as 1|2,calibrationActive:false,persistence:field(f,'persistence') as 'session'|'flash',semantics:semantics as ParsedModes['semantics'],flightEnabled:bit(field(f,'flight_enabled')),armed:bit(field(f,'armed')),benchActive:bit(field(f,'bench_active')),rxFresh,modes,channels,source:f.get('source')};
 if(apiVersion===2){
  const source=field(f,'control_source'),requested=field(f,'requested_mode'),effective=field(f,'effective_mode');
  if(source!=='manual'&&source!=='aux')throw Error('Invalid control source');
  if(!['angle','acro','horizon'].includes(requested)||!['angle','acro','horizon'].includes(effective))throw Error('Invalid control mode');
  const armSemantics=field(f,'arm_semantics');
  if(armSemantics!=='preview'&&armSemantics!=='configured')throw Error('Unsupported ARM semantics');
  const conflict=bit(field(f,'mode_conflict')),matches=modes.filter(m=>m.name!=='ARM'&&m.active);
  if(conflict!==(source==='aux'&&matches.length>1))throw Error('Contradictory conflict indication');
  if(source==='aux'){
   const expected=matches.length===1?matches[0].name.toLowerCase():'angle';
   if(requested!==expected)throw Error('Contradictory AUX selection');
  }
  if(base.flightEnabled&&source==='aux')throw Error('AUX mode routing is unavailable in this firmware');
  const levelFallback=parseLevelFallback(f,effective as ControlMode);
  return {...base,calibrationActive:bit(field(f,'calibration_active')),armSemantics,controlSource:source,requestedMode:requested as ControlMode,effectiveMode:effective as ControlMode,modeConflict:conflict,...(levelFallback?{levelFallback}:{})};
 }
 return base;
}
export function isControlSourceCommand(s:string):boolean{return s==='control_source manual'||s==='control_source aux';}
export function controlSourceCommand(source:'manual'|'aux'):CliCommand{
 const cmd=`control_source ${source}`;if(!isControlSourceCommand(cmd))throw Error('Invalid control source');return cmd as CliCommand;
}
export function canEditModeRanges(s:ParsedModes|null,connected:boolean,pending:boolean):boolean{
 return connected&&!!s&&!pending&&!s.armed&&!s.benchActive&&!s.calibrationActive;
}
export function canSelectControlSource(s:ParsedModes|null,connected:boolean,pending:boolean):boolean{
 return canEditModeRanges(s,connected,pending)&&s?.apiVersion===2&&!s.flightEnabled;
}
export function isControlModeCommand(s:string):boolean{return s==='control_mode angle'||s==='control_mode acro'||s==='control_mode horizon';}
export function controlModeCommand(mode:'angle'|'acro'|'horizon'):CliCommand{
 const cmd=`control_mode ${mode}`;if(!isControlModeCommand(cmd))throw Error('Invalid control mode');return cmd as CliCommand;
}
export function canSelectControlMode(s:ParsedModes|null,connected:boolean,pending:boolean):boolean{
 return canEditModeRanges(s,connected,pending)&&s?.apiVersion===2;
}
export function isModeRangeCommand(s:string):boolean{const a=s.split(' ');if(a.length!==6||a[0]!=='mode_range'||!['ARM','ANGLE','ACRO','HORIZON'].includes(a[1]))return false;try{bit(a[2]);uint(a[3],1,12);return uint(a[4],900,2100)<uint(a[5],900,2100);}catch{return false;}}
export function modeRangeCommand(m:Pick<ModeRow,'name'|'enabled'|'aux'|'minUs'|'maxUs'>):CliCommand{const s=`mode_range ${m.name} ${m.enabled?1:0} ${m.aux} ${m.minUs} ${m.maxUs}`;if(!isModeRangeCommand(s))throw Error('Invalid mode range: numeric AUX 1–12 and integer bounds 900–2100 required');return s as CliCommand;}
