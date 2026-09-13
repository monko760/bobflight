/* SPDX-License-Identifier: Apache-2.0 */
import type { CliCommand } from './types';
export interface ModeRow {name:'ARM'|'ANGLE';enabled:boolean;aux:number;minUs:number;maxUs:number;active:boolean}
export interface ParsedModes {raw:string; persistence:'session';semantics:'control'|'preview';flightEnabled:boolean;armed:boolean;benchActive:boolean;rxFresh:boolean;modes:ModeRow[];channels?:number[];source?:string}
export function uint(s:string,lo:number,hi:number):number {if(!/^(0|[1-9]\d*)$/.test(s))throw Error('Expected canonical unsigned integer');const n=Number(s);if(!Number.isSafeInteger(n)||n<lo||n>hi)throw Error('Integer outside supported bounds');return n;}
export function bit(s:string):boolean {return uint(s,0,1)===1;}
export function snapshot(raw:string,kind:string,rowKey:string):{fields:Map<string,string>;rows:string[]} {
 const lines=raw.trim().split(/\r?\n/);if(lines[0]!==`${kind}_api: 1`||lines.at(-1)!==`${kind}_end: 1`)throw Error(`Unsupported or incomplete ${kind} response`);
 const fields=new Map<string,string>(),rows:string[]=[];
 for(const line of lines.slice(1,-1)){const m=/^([a-z_]+): (.*)$/.exec(line);if(!m)throw Error('Malformed snapshot line');if(m[1]===rowKey){rows.push(m[2]);continue;}if(fields.has(m[1])||m[1]===`${kind}_api`||m[1]===`${kind}_end`)throw Error('Duplicate snapshot field');fields.set(m[1],m[2]);}
 return {fields,rows};
}
export function field(f:Map<string,string>,key:string):string{const x=f.get(key);if(x===undefined)throw Error(`Missing ${key}`);return x;}
export function parseModes(raw:string):ParsedModes {
 const {fields:f,rows}=snapshot(raw,'modes','mode');if(field(f,'persistence')!=='session')throw Error('Unsupported persistence');const semantics=field(f,'semantics');if(semantics!=='control'&&semantics!=='preview')throw Error('Unsupported mode semantics');
 const rxFresh=bit(field(f,'rx_fresh'));const modes:ModeRow[]=rows.map(r=>{const a=r.split(',');if(a.length!==6||(a[0]!=='ARM'&&a[0]!=='ANGLE'))throw Error('Invalid mode row');const enabled=bit(a[1]),aux=uint(a[2],1,12),minUs=uint(a[3],900,2100),maxUs=uint(a[4],900,2100),active=bit(a[5]);if(minUs>=maxUs||active&&(!rxFresh||!enabled))throw Error('Contradictory mode row');return {name:a[0],enabled,aux,minUs,maxUs,active};});
 if(modes.length!==2||new Set(modes.map(m=>m.name)).size!==2)throw Error('Expected one ARM and one ANGLE row');
 let channels:number[]|undefined;if(f.has('channels')){channels=field(f,'channels').split(',').map(v=>uint(v,900,2100));if(channels.length!==16)throw Error('Expected 16 channels');}
 return {raw,persistence:'session',semantics,flightEnabled:bit(field(f,'flight_enabled')),armed:bit(field(f,'armed')),benchActive:bit(field(f,'bench_active')),rxFresh,modes,channels,source:f.get('source')};
}
export function isModeRangeCommand(s:string):boolean{const a=s.split(' ');if(a.length!==6||a[0]!=='mode_range'||!['ARM','ANGLE'].includes(a[1]))return false;try{bit(a[2]);uint(a[3],1,12);return uint(a[4],900,2100)<uint(a[5],900,2100);}catch{return false;}}
export function modeRangeCommand(m:Pick<ModeRow,'name'|'enabled'|'aux'|'minUs'|'maxUs'>):CliCommand{const s=`mode_range ${m.name} ${m.enabled?1:0} ${m.aux} ${m.minUs} ${m.maxUs}`;if(!isModeRangeCommand(s))throw Error('Invalid mode range: numeric AUX 1–12 and integer bounds 900–2100 required');return s as CliCommand;}
