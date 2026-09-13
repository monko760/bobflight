/* SPDX-License-Identifier: Apache-2.0 */
import {isModeRangeCommand,isControlSourceCommand} from './parse-modes';
/** Offline demo: no invented receiver freshness or physical output success. */
export class MockPortsModes {
 private rows:string[]=[];
 private source:'manual'|'aux'='manual';
 constructor(){this.reset();}
 reset():void{this.source='manual';this.rows=['ARM,1,1,1751,2100,0','ANGLE,1,2,900,2100,0','ACRO,0,2,900,2100,0','HORIZON,0,2,900,2100,0'];}
 handle(s:string,armed:boolean,bench:boolean):string|null{
  if(s==='reboot'){this.reset();return null;}
  const state=[`armed: ${+armed}`,`bench_active: ${+bench}`];
  if(s==='ports')return ['ports_api: 1','board: mock-no-hardware','source: mock','receiver_uart: 0','reboot_required: no','persistence: session',...state,'port: 0,USB_VCP,-,-,cli,0','ports_end: 1',''].join('\r\n');
  if(s.startsWith('control_source')){
   if(armed||bench||!isControlSourceCommand(s))return 'control_source refused: invalid request or motors not stopped\r\n';
   this.source=s.endsWith('aux')?'aux':'manual';
  }else if(s.startsWith('mode_range')){
   if(armed||bench||!isModeRangeCommand(s))return 'mode_range refused: invalid request or motors not stopped\r\n';
   const a=s.split(' '),index=['ARM','ANGLE','ACRO','HORIZON'].indexOf(a[1]);this.rows[index]=[...a.slice(1),'0'].join(',');
  }else if(s!=='modes')return null;
  return ['modes_api: 2','persistence: session','source: mock','semantics: bench-control','flight_enabled: 0',...state,'calibration_active: 0','rx_fresh: 0','arm_semantics: preview',`control_source: ${this.source}`,'requested_mode: angle','effective_mode: angle','mode_conflict: 0',...this.rows.map(r=>'mode: '+r),'modes_end: 1',''].join('\r\n');
 }
}
