/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {BobFlightCliClient,MockTransportFactory}=require('../dist');
(async()=>{const c=new BobFlightCliClient(new MockTransportFactory());await c.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,15));
for(const x of ['sd read 0','sd read 62333951','sd read 4294967295'])assert.match(await c.sendCommand(x),/sd_data_error: unavailable-mock[\s\S]*sd_data_end: 1/);
for(const x of ['sd read -1','sd read +1','sd read 00','sd read 4294967296','sd read 1.0','sd read 1\narm','sd write 0','sd read 1 extra'])await assert.rejects(()=>c.sendCommand(x),/unsupported/);
assert(!c.getSentCommands().includes('arm'));await c.disconnect();console.log('PASS SD read allowlist, unsigned bounds, correct framing, honest mock and injection rejection');})().catch(e=>{console.error(e);process.exitCode=1;});
