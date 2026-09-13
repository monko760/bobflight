/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict'),path=require('node:path');
const {loadUiTs}=require('../../protocol/tests/load-ui-ts.cjs');
const P=require('../../protocol/dist');
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
async function main(){
 const sent=[];let pending=null,input='bench_switch',hook=0;
 const {CliPage}=loadUiTs(path.resolve(__dirname,'../src/pages/CliPage.tsx'),{
  react:{...require('react'),useEffect:()=>{},useRef:()=>({current:null}),useState:()=>{const i=hook++;return i===0?[input,v=>input=v]:i===1?[null,()=>{}]:[pending,v=>pending=v];}},
  '../hooks/useHost':{useHost:()=>({host:{sendCommand:async cmd=>sent.push(cmd)},connectionStatus:'connected',cliLines:[],appendCli:()=>{},refreshStatus:()=>{}})},
  '../protocol':loadUiTs(path.resolve(__dirname,'../src/protocol/types.ts'))
 });
 let tree=CliPage();nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(pending,'bench_switch');assert.equal(sent.length,0);
 hook=0;tree=CliPage();const confirm=nodes(tree).find(n=>typeof n.type==='function'&&n.type.name==='ConfirmDialog');
 assert.match(confirm.props.message,/propellers are removed/);await confirm.props.onConfirm();
 assert.deepEqual(sent,['bench_switch']);
 input='bench_stop';hook=0;tree=CliPage();nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(sent,['bench_switch','bench_stop']);
 input='bench_switch extra';hook=0;tree=CliPage();nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(sent.length,2);
 const client=new P.BobFlightCliClient(new P.MockTransportFactory());
 await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,20));
 await assert.rejects(()=>client.sendCommand('bench_switch extra'),/unsupported/);
 await assert.rejects(()=>client.sendCommand('bench_stop\narm'),/unsupported/);
 await client.sendCommand('bench_switch');await client.sendCommand('bench_stop');await client.disconnect();
 console.log('PASS bench CLI confirmation, immediate stop, malformed input rejection and protocol allowlist');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
