/* SPDX-License-Identifier: Apache-2.0 */
import {isModeRangeCommand,isControlModeCommand} from './parse-modes';
/** Offline demo: no invented receiver freshness or physical output success. */
export class MockPortsModes {
 private rows:string[]=[];
 private mode:'angle'|'acro'|'horizon'='angle';
 constructor(){this.reset();}
 reset():void{this.mode='angle';this.rows=['ARM,1,1,1751,2100,0','ANGLE,1,2,900,2100,0','ACRO,0,2,900,2100,0','HORIZON,0,2,900,2100,0'];}
 handle(s:string,armed:boolean,bench:boolean):string|null{
  if(s==='reboot'){this.reset();return null;}
  const state=[`armed: ${+armed}`,`bench_active: ${+bench}`];
  if(s==='ports')return ['ports_api: 1','board: mock-no-hardware','source: mock','receiver_uart: 0','reboot_required: no','persistence: session',...state,'port: 0,USB_VCP,-,-,cli,0','ports_end: 1',''].join('\r\n');
  if(s.startsWith('control_source')){
   if(armed||bench)return 'control_source refused: manual only; disarm, stop motors and calibration\r\n';
   if(s!=='control_source manual')return 'control_source refused: manual only; disarm, stop motors and calibration\r\n';
  }else if(s.startsWith('control_mode')){
   if(armed||bench||!isControlModeCommand(s))return 'control_mode refused: invalid request or motors not stopped\r\n';
   this.mode=s.split(' ')[1] as 'angle'|'acro'|'horizon';
  }else if(s.startsWith('mode_range')){
   if(armed||bench||!isModeRangeCommand(s))return 'mode_range refused: invalid request or motors not stopped\r\n';
   const a=s.split(' '),index=['ARM','ANGLE','ACRO','HORIZON'].indexOf(a[1]);this.rows[index]=[...a.slice(1),'0'].join(',');
  }else if(s!=='modes')return null;
  return ['modes_api: 2','persistence: session','source: mock','semantics: bench-control','flight_enabled: 1',...state,'calibration_active: 0','rx_fresh: 0','arm_semantics: preview',`control_source: manual`,`requested_mode: ${this.mode}`,`effective_mode: ${this.mode}`,'mode_conflict: 0',...this.rows.map(r=>'mode: '+r),'modes_end: 1',''].join('\r\n');
 }
}
