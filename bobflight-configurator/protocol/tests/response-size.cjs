/* SPDX-License-Identifier: Apache-2.0 */
const assert=require('node:assert/strict');
const {ResponseCollector}=require('../dist');
(async()=>{
 let resolveCount=0,rejectCount=0,error;
 const c=new ResponseCollector(()=>resolveCount++,e=>{rejectCount++;error=e;},{endMarker:'download_end: 1',timeoutMs:20});
 for(let n=0;n<64;n++)c.push('x'.repeat(1024));
 assert.equal(rejectCount,0);c.push('x');assert.equal(rejectCount,1);assert.match(error.message,/exceeds/);
 c.push('\r\ndownload_end: 1\r\n');c.cancel();assert.equal(resolveCount,0);assert.equal(rejectCount,1);
 const good=await new Promise((resolve,reject)=>{const x=new ResponseCollector(resolve,reject,{endMarker:'download_end: 1'});x.push('download_hex: '+ 'AB'.repeat(512)+'\r\n');x.push('download_end: 1\r\n');});
 assert(good.endsWith('download_end: 1\r\n'));
 console.log('PASS bounded response retention, one terminal rejection, valid split 512-byte download framing');
})().catch(e=>{console.error(e);process.exitCode=1;});
