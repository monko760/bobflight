/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBuildMiddleware, resolveBuildProfile } from './local-hex-builder.mjs';
const selection=(boardId='mltempf4',extra={})=>({boardId,customMcu:'',customFlash:'',customHse:'',...extra});
for(const id of ['kakute_f7_hdv','tmotor_f7_v2','mltempf4'])assert.equal(resolveBuildProfile(selection(id)).boardId,id);
assert(resolveBuildProfile(selection('custom_f405xg_usb',{customMcu:'STM32F405',customFlash:'1024',customHse:'8000000'})).diagnostic);
for(const bad of [null,[],{},selection('dummy'),selection('../kakute_f7_hdv'),selection('stm32h743'),selection('mltempf4',{flags:'-DARM=1'}),selection('custom_f405xg_usb'),selection('custom_f405xg_usb',{customMcu:'STM32F405',customFlash:'512',customHse:'8000000'})])assert.throws(()=>resolveBuildProfile(bad));
let starts=0,finish,aborted=false;
const middleware=createBuildMiddleware({compile:async(p,ctx)=>{starts++;ctx.log('bounded build log');return await new Promise((resolve,reject)=>{finish=()=>resolve({fileName:'verified.hex',hex:':00000001FF\n',profile:p.profile});ctx.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});});}});
const server=http.createServer((req,res)=>{void middleware(req,res,()=>{res.statusCode=404;res.end();});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const get=(headers={})=>new Promise((resolve,reject)=>{http.get(origin+'/__bobflight_build',{headers},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(body)}));}).on('error',reject);});
try {
  assert.equal((await get({Origin:'https://evil.test'})).status,403);
  assert.equal((await get({Host:'evil.test'})).status,403);
  assert.equal((await get({Origin:origin.replace('http:','https:')})).status,403);
  assert.equal((await get({'Sec-Fetch-Site':'cross-site'})).status,403);
  const caps=await (await get({Origin:origin})).json();assert.equal(caps.protocol,1);assert.equal(starts,0);
  const headers={'Content-Type':'application/json','X-Bobflight-Build-Token':caps.token,Origin:origin};
  const post=(body,extra={})=>fetch(origin+'/__bobflight_build',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await post(selection(),{'X-Bobflight-Build-Token':'bad'})).status,403);
  assert.equal((await post(selection(),{'X-Bobflight-Build-Token':'é'.repeat(64)})).status,403);
  assert.equal((await post(selection(),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post(selection('dummy'))).status,400);assert.equal(starts,0);
  const first=post(selection());while(starts!==1)await new Promise(r=>setTimeout(r,5));
  assert.equal((await post(selection())).status,409);assert.equal(starts,1);finish();
  const result=await first;assert.equal(result.status,200);assert.equal((await result.json()).log,'bounded build log');
  const controller=new AbortController();const second=fetch(origin+'/__bobflight_build',{method:'POST',headers,body:JSON.stringify(selection()),signal:controller.signal}).catch(()=>{});
  while(starts!==2)await new Promise(r=>setTimeout(r,5));controller.abort();await second;
  for(let i=0;i<100&&!aborted;i++)await new Promise(r=>setTimeout(r,5));assert(aborted);
  console.log('PASS local builder: exact recipes, unsupported generic blocked, no arbitrary parameters, GET never compiles, origin/host/token/type guards, one active build, disconnect cancellation.');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
