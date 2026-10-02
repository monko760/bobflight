/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * BB1 QA F2 readouts (frozen by the Config Lead): blackbox_missed_pct,
 * blackbox_logged_hz and blackbox_missed_state are appended to the api 2
 * `blackbox status` reply just before blackbox_end. The api number stays 2
 * ONLY because the Configurator parser that already shipped on main accepts
 * the extra lines unchanged. This script proves it: real firmware output (the
 * SD throughput model) -> real protocol framing -> the onboard parser from
 * origin/main (and the in-tree one), and checks the three values against the
 * frozen formulas. Set BB_SHIPPED_PARSER=<path> to test a specific parser file.
 */
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync,execFileSync}=require('node:child_process');
const {ResponseCollector,formatDropPct}=require('../../bobflight-configurator/protocol/dist');
const {loadUiTs}=require('../../bobflight-configurator/protocol/tests/load-ui-ts.cjs');
const root=path.resolve(__dirname,'../..');
const PARSER='bobflight-configurator/ui/src/blackbox/onboard.ts';
const binary=process.argv[2]?path.resolve(process.argv[2]):path.resolve(root,'bobflight-firmware/build-contract/bobflight_blackbox_throughput_test');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bbl-f2-'));

/* The shipped parser: origin/main's onboard.ts (fetched shallowly if CI has no origin/main). */
function shippedParser(){
 if(process.env.BB_SHIPPED_PARSER)return {file:path.resolve(process.env.BB_SHIPPED_PARSER),ref:'BB_SHIPPED_PARSER'};
 const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const show=()=>({src:git('show','origin/main:'+PARSER),sha:git('rev-parse','origin/main').trim()});
 let got;
 try{got=show();}catch{
  git('fetch','--no-tags','--depth=1','origin','+refs/heads/main:refs/remotes/origin/main');
  got=show();
 }
 // Its only import is type-only (erased by the transpiler), so a temp copy loads standalone.
 const file=path.join(tmp,'onboard.origin-main.ts');fs.writeFileSync(file,got.src);
 return {file,ref:'origin/main@'+got.sha.slice(0,7)};
}
const shipped=shippedParser();
const parsers=[
 {name:shipped.ref,mod:loadUiTs(shipped.file)},
 {name:'in-tree',mod:loadUiTs(path.join(root,PARSER))},
];

const f2=path.join(tmp,'f2.txt'),std=path.join(tmp,'status.txt');
const r=spawnSync(binary,[std,f2],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:300000});
assert.equal(r.status,0,r.stdout+r.stderr);
const replies=[];
for(const chunk of fs.readFileSync(f2,'utf8').split('---\n').filter(Boolean)){
 const nl=chunk.indexOf('\n');assert(chunk.startsWith('#'));replies.push({label:chunk.slice(1,nl),raw:chunk.slice(nl+1)});
}
fs.readFileSync(std,'utf8').split('---\n').filter(Boolean).forEach((raw,i)=>replies.push({label:'api2-contract-'+i,raw}));
const labels=replies.map(x=>x.label);
for(const want of ['idle','stall20s-mid','stall20s-done','burst-done','after-high-init','clean-early','clean-mid','clean-done'])assert(labels.includes(want),'missing reply '+want);

const NEW=['blackbox_missed_pct','blackbox_logged_hz','blackbox_missed_state'];
const field=(raw,k)=>{const m=new RegExp('^'+k+': (.*)$','m').exec(raw.replace(/\r/g,''));return m?m[1]:undefined;};
const strip=raw=>raw.split('\r\n').filter(l=>!NEW.some(k=>l.startsWith(k+': '))).join('\r\n');
const frame=raw=>{ // real protocol framing, end marker split across two chunks
 let value=null,error=null;
 const c=new ResponseCollector(x=>value=x,e=>error=e,{idleMs:1,timeoutMs:100,endMarker:'blackbox_end: 1'});
 const cut=raw.indexOf('blackbox_end: 1')+4;c.push(raw.slice(0,cut));assert.equal(value,null);c.push(raw.slice(cut));
 assert.equal(error,null);assert.equal(value,raw);return value;
};
const states=new Set();
for(const {label,raw} of replies){
 // Frozen layout: the three keys, in order, immediately before blackbox_end.
 const lines=raw.trimEnd().split('\r\n');
 assert.deepEqual(lines.slice(-4).map(l=>l.split(': ')[0]),[...NEW,'blackbox_end'],label);
 const frames=Number(field(raw,'blackbox_frames')),dropped=Number(field(raw,'blackbox_dropped')),missed=Number(field(raw,'blackbox_missed'));
 const mp=field(raw,'blackbox_missed_pct'),hz=field(raw,'blackbox_logged_hz'),st=field(raw,'blackbox_missed_state');
 // missed_pct: missed/(frames+dropped+missed), drop_pct's format and rounding (formatDropPct(frames,lost) = lost/(frames+lost)).
 assert.match(mp,/^(?:100|[1-9]?\d)\.\d$/,label);assert.equal(mp,formatDropPct(frames+dropped,missed),label);
 assert.equal(field(raw,'blackbox_drop_pct'),formatDropPct(frames,dropped),label); // drop_pct unchanged
 // missed_state: high only when the printed pct is above 1.0 (same tenths the FC printed).
 const tenths=Number(mp.replace('.',''));assert.equal(st,tenths>10?'high':'ok',label);states.add(st);
 // logged_hz: one decimal while recording (>= 1 s), else "unavailable".
 if(hz!=='unavailable'){assert.match(hz,/^(?:0|[1-9]\d*)\.\d$/,label);assert.equal(field(raw,'blackbox_state'),'recording',label);}
 else assert(field(raw,'blackbox_state')!=='recording'||label==='clean-early',label);
 for(const p of parsers){
  const a=p.mod.parseOnboardReply(frame(raw)),b=p.mod.parseOnboardReply(strip(raw));
  assert.equal(a.api,2);assert(!a.unavailable);
  assert.deepEqual({...a,raw:''},{...b,raw:''},`${p.name}: the extra lines changed the parsed snapshot (${label})`);
 }
}
const get=l=>replies.find(x=>x.label===l).raw;
assert.equal(field(get('idle'),'blackbox_logged_hz'),'unavailable');assert.equal(field(get('idle'),'blackbox_missed_pct'),'0.0');
assert.equal(field(get('stall20s-mid'),'blackbox_missed_state'),'high');assert.notEqual(field(get('stall20s-mid'),'blackbox_logged_hz'),'unavailable');
assert.equal(field(get('burst-done'),'blackbox_missed_state'),'high');assert.equal(field(get('burst-done'),'blackbox_rate_reason'),'default');
assert.equal(field(get('after-high-init'),'blackbox_missed_pct'),'0.0');assert.equal(field(get('clean-early'),'blackbox_logged_hz'),'unavailable');
assert.equal(field(get('clean-done'),'blackbox_missed_state'),'ok');
assert(states.has('ok')&&states.has('high'));
// Control: the shipped parser rejects any other api number, so bumping the api would break it.
for(const api of ['3','0'])assert.throws(()=>parsers[0].mod.parseOnboardReply(get('clean-mid').replace('blackbox_api: 2','blackbox_api: '+api)),/unsupported/i);
console.log(`PASS F2 blackbox status readouts: ${replies.length} real firmware replies (stall >1 % high, missed burst, reset at start, idle/live/done) parse unchanged with the shipped parser (${shipped.ref}) and in-tree parser; missed_pct = formatDropPct(frames+dropped, missed), state high only above the printed 1.0, logged_hz only while recording; api 2 kept (shipped parser rejects api 3)`);
