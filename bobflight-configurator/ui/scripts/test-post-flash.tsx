// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {installFakeDom} from './fixtures/fakeDom';
import {HostProvider,useHost} from '../src/hooks/useHost';
import {TestInjectedHost,setInjectedHost} from './fixtures/injectedHostFixture';
const {container}=installFakeDom(); const host=new TestInjectedHost();
host.connectionStatus='connected'; host.statusValue={board:'tmotor_f7_v2'} as any;
setInjectedHost(host);let ctx!:ReturnType<typeof useHost>;
function Probe(){ctx=useHost();return <div>{ctx.postFlashGate?'locked':'unlocked'}</div>}
const root=createRoot(container as never);flushSync(()=>root.render(<HostProvider><Probe/></HostProvider>));
const settle=()=>new Promise(r=>setTimeout(r,15));
const arm=(board='tmotor_f7_v2')=>flushSync(()=>ctx.setPostFlashGate(true,board));
const connect=(state:any)=>flushSync(()=>host.setConnectionStatus(state));
async function clear(){const result=await ctx.clearPostFlashGateAfterReconnect();await settle();return result;}
arm();host.statusValue={board:'wrong_target'} as any;
assert.equal(await clear(),false);assert(ctx.postFlashGate);
host.statusValue={board:'tmotor_f7_v2'} as any;host.isLive=false;
assert.equal(await clear(),false);await ctx.pollAfterConnect();await settle();assert(ctx.postFlashGate);
host.isLive=true;host.versionValue='';assert.equal(await clear(),false);
host.versionValue='BobFlight test build';host.statusValue=null;assert.equal(await clear(),false);
host.statusValue={board:'tmotor_f7_v2'} as any;
assert.equal(await clear(),true);assert(!ctx.postFlashGate);
arm();flushSync(()=>ctx.setPostFlashGate(false));assert(ctx.postFlashGate);
await ctx.pollAfterConnect();await settle();assert(!ctx.postFlashGate);
console.log('PASS provider: wrong board/mock/missing replies/set-false blocked; fresh live reply unlocks');
arm();host.versionDelayMs=35;const detached=ctx.clearPostFlashGateAfterReconnect();connect('disconnected');
assert.equal(await detached,false);await settle();assert(ctx.postFlashGate);assert.equal(ctx.version,null);
connect('connected');const crossed=ctx.clearPostFlashGateAfterReconnect();arm('other_target');
assert.equal(await crossed,false);await settle();assert.equal(ctx.version,null);assert(ctx.postFlashGate);
// Previously captured handlers must use the latest expected board, not stale React closures.
const oldClear=ctx.clearPostFlashGateAfterReconnect;arm('new_target');
assert.equal(await oldClear(),false);assert(ctx.postFlashGate);
host.versionDelayMs=0;arm();host.statusDelayMs=35;
const refresh=ctx.refreshStatus();connect('disconnected');connect('connected');await refresh;await settle();
assert.equal(ctx.status,null,'old status must not be installed after reconnect');host.statusDelayMs=0;
console.log('PASS provider: disconnect, new flash, stale callback and status-refresh generations');
arm();host.versionError=new Error('USB link lost');assert.equal(await clear(),false);assert.equal(ctx.lastError,'USB link lost');
await assert.rejects(()=>ctx.pollAfterConnect(),/USB link lost/);await settle();assert(ctx.postFlashGate);
host.versionError=null;assert.equal(await clear(),true);flushSync(()=>root.unmount());
console.log('PASS provider: errors visible, failed verification remains locked and retry can succeed');
