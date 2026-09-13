/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {parsePorts,parseModes,modeRangeCommand,isModeRangeCommand,MockPortsModes,ResponseCollector,BobFlightCliClient,MockTransportFactory}=require('../dist');
async function main(){
 const mock=new MockPortsModes();const initial=mock.handle('modes',false,false),ports=mock.handle('ports',false,false);
 assert.equal(parsePorts(ports).ports[0].id,0);assert.equal(parsePorts(ports).source,'mock');
 const m=parseModes(initial);assert.equal(m.modes[0].aux,1);assert.equal(m.modes[1].aux,2);assert.equal(m.semantics,'preview');
 const command=modeRangeCommand({...m.modes[0],aux:12,minUs:1100,maxUs:1450});assert.equal(command,'mode_range ARM 1 12 1100 1450');
 const updated=parseModes(mock.handle(command,false,false));assert.equal(updated.modes[0].aux,12);
 for(const bad of ['mode_range ARM 1 aux1 1100 1450','mode_range ARM 1 0 1100 1450','mode_range ARM 1 13 1100 1450','mode_range ARM 1 257 1100 1450','mode_range ARM 1 +1 1100 1450','mode_range ARM 1 01 1100 1450','mode_range ARM 1 1.0 1100 1450','mode_range ARM 1 1 899 1450','mode_range ARM 1 1 1100 2101','mode_range ARM 1 1 1500 1500','mode_range ARM 1 1 1100.5 1450','mode_range ARM 1 1 1100 1450\narm']){assert.equal(isModeRangeCommand(bad),false,bad);assert.match(mock.handle(bad,false,false),/refused/);}
 assert.match(mock.handle(command,true,false),/refused/);assert.match(mock.handle(command,false,true),/refused/);
 for(const bad of [initial.replace('ARM,1,1,','ARM,1,aux1,'),initial.replace('ARM,1,1,','ARM,1,13,'),initial.replace('modes_end: 1',''),initial.replace('modes_end: 1','mode: ARM,1,1,1751,2100,0\r\nmodes_end: 1'),initial.replace('rx_fresh: 0','rx_fresh: 0\r\nrx_fresh: 1'),initial.replace('1751,2100,0','1751,2100,1')])assert.throws(()=>parseModes(bad));
 for(const bad of [ports.replace('port: 0,','port: USB0,'),ports.replace('ports_end: 1','port: 0,USB_VCP,-,-,cli,0\r\nports_end: 1'),ports.replace('receiver_uart: 0','receiver_uart: 6')])assert.throws(()=>parsePorts(bad));
 let done=null;const c=new ResponseCollector(x=>done=x,e=>{throw e},{endMarker:'modes_end: 1'});c.push(initial.slice(0,-2));assert.equal(done,null);c.push('\r\n');assert.equal(done,initial);
 let refused=null;const r=new ResponseCollector(x=>refused=x,e=>{throw e},{endMarker:'modes_end: 1'});r.push('mode_range refused: disarmed required');assert.equal(refused,null);r.push('\r\n');assert.match(refused,/refused/);
 let legacy=null;const l=new ResponseCollector(x=>legacy=x,e=>{throw e},{endMarker:'modes_end: 1'});l.push('unknown — try help\r\n');assert.match(legacy,/unknown/);
 await new Promise((resolve,reject)=>{const t=new ResponseCollector(()=>reject(Error('Accepted partial report')),e=>{assert.match(e.message,/terminator missing/);resolve();},{endMarker:'modes_end: 1',timeoutMs:10});t.push('modes_api: 1\r\n');});
 const client=new BobFlightCliClient(new MockTransportFactory());await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,20));
 assert.equal(parseModes(await client.sendCommand(command)).modes[0].aux,12);assert.equal(parsePorts(await client.sendCommand('ports')).receiverUart,0);
 await assert.rejects(()=>client.sendCommand('mode_range ARM 1 aux1 1100 1450'),/unsupported/);await client.disconnect();
 mock.handle('reboot',false,false);assert.equal(parseModes(mock.handle('modes',false,false)).modes[0].aux,1);
 console.log('PASS Ports/Modes: numeric AUX1/AUX12, exact serialization, strict rejection, atomic mock/guards/reset, complete framing/refusals/legacy/truncation, real client mock roundtrip');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
