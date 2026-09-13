/* SPDX-License-Identifier: Apache-2.0 */
import {isModeRangeCommand} from './parse-modes';
/** Offline preview config only. No invented receiver or physical UART success. */
export class MockPortsModes {
 private rows=['ARM,1,1,1751,2100,0','ANGLE,1,2,900,2100,0'];
 reset():void{this.rows=['ARM,1,1,1751,2100,0','ANGLE,1,2,900,2100,0'];}
 handle(s:string,armed:boolean,bench:boolean):string|null{
  if(s==='reboot'){this.reset();return null;}
  const state=[`armed: ${+armed}`,`bench_active: ${+bench}`];
  if(s==='ports')return ['ports_api: 1','board: mock-no-hardware','source: mock','receiver_uart: 0','reboot_required: no','persistence: session',...state,'port: 0,USB_VCP,-,-,cli,0','ports_end: 1',''].join('\r\n');
  if(s.startsWith('mode_range')){if(armed||bench||!isModeRangeCommand(s))return 'mode_range refused: invalid request or motors not stopped\r\n';const a=s.split(' ');this.rows[a[1]==='ARM'?0:1]=[...a.slice(1),'0'].join(',');}
  else if(s!=='modes')return null;
  return ['modes_api: 1','persistence: session','source: mock','semantics: preview','flight_enabled: 0',...state,'rx_fresh: 0',...this.rows.map(r=>'mode: '+r),'modes_end: 1',''].join('\r\n');
 }
}
