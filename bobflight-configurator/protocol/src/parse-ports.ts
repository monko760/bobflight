/* SPDX-License-Identifier: Apache-2.0 */
import {snapshot,field,uint,bit} from './parse-modes';
export interface PortRow{id:number;label:string;txPin:string;rxPin:string;role:'cli'|'crsf'|'none';selectable:boolean}
export interface ParsedPorts{raw:string;board:string;receiverUart:number;rebootRequired:boolean;persistence:'session'|'flash';armed:boolean;benchActive:boolean;ports:PortRow[];source?:string}
export function parsePorts(raw:string):ParsedPorts{
 const {fields:f,rows}=snapshot(raw,'ports','port');const board=field(f,'board');if(!/^[a-zA-Z0-9_.-]+$/.test(board))throw Error('Invalid board ID');if(!['session','flash'].includes(field(f,'persistence')))throw Error('Unsupported persistence');const rr=field(f,'reboot_required');if(rr!=='no'&&rr!=='yes')throw Error('Invalid reboot requirement');const receiverUart=uint(field(f,'receiver_uart'),0,255);
 const pins=/^(?:-|P[A-K](?:[0-9]|1[0-5]))$/;
 const ports:PortRow[]=rows.map(r=>{const a=r.split(',');if(a.length!==6||!pins.test(a[2])||!pins.test(a[3]))throw Error('Invalid port row');const id=uint(a[0],0,255),selectable=bit(a[5]);if(!/^[A-Za-z0-9_-]+$/.test(a[1])||!['cli','crsf','none'].includes(a[4]))throw Error('Invalid port role/label');if(id===0&&(a[4]!=='cli'||selectable||a[2]!=='-'||a[3]!=='-'))throw Error('USB must be fixed CLI');if(id!==0&&(a[4]==='cli'||selectable&&a[3]==='-'))throw Error('Invalid UART capability');return {id,label:a[1],txPin:a[2],rxPin:a[3],role:a[4] as PortRow['role'],selectable};});
 if(!ports.some(p=>p.id===0)||new Set(ports.map(p=>p.id)).size!==ports.length)throw Error('Missing USB or duplicate port');const rx=ports.filter(p=>p.role==='crsf');if(receiverUart===0?rx.length!==0:rx.length!==1||rx[0].id!==receiverUart)throw Error('Inconsistent receiver assignment');
 return {raw,board,receiverUart,rebootRequired:rr==='yes',persistence:field(f,'persistence') as 'session'|'flash',armed:bit(field(f,'armed')),benchActive:bit(field(f,'bench_active')),ports,source:f.get('source')};
}
