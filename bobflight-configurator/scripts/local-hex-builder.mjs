/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
// Local trusted-source compiler. No HTTP-supplied commands, paths, flags or source.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const LIMIT = 8 * 1024 * 1024;
const known = ['kakute_f7_hdv', 'tmotor_f7_v2', 'mltempf4', 'custom_f405xg_usb'];
export function resolveBuildProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['boardId','customMcu','customFlash','customHse'].includes(k))) throw new Error('Only board/profile selections are accepted.');
  for (const key of ['boardId','customMcu','customFlash','customHse']) if (typeof input[key] !== 'string' || input[key].length > 64) throw new Error('Invalid board/profile fields.');
  if (!known.includes(input.boardId)) throw new Error('No hardware build recipe for this board. No fallback target is selected.');
  const diagnostic = input.boardId === 'mltempf4' || input.boardId === 'custom_f405xg_usb';
  if (input.boardId === 'custom_f405xg_usb' && (input.customMcu !== 'STM32F405' || input.customFlash !== '1024' || input.customHse !== '8000000')) throw new Error('Custom builds currently require F405xG / 1024 KiB / 8 MHz. Other MCU and routing combinations are not implemented.');
  return Object.freeze({ boardId:input.boardId, diagnostic, profile:diagnostic?'f405-usb-diagnostic':'main',
    label:diagnostic?'Experimental USB-only reference image; no sensors, motors, storage or bl command.':input.boardId==='tmotor_f7_v2'?'T-Motor F7 V2 sensor-only firmware; no motor output.':'Kakute F7 HDV development firmware; not flight-qualified.' });
}
async function buildEnvironment(repo) {
  const env={...process.env};const original=env.PATH||env.Path||'';
  for (const k of Object.keys(env)) if (k.toLowerCase()==='path') delete env[k];
  const root=process.env.BOBFLIGHT_TOOL_ROOT||path.join(repo,'tools');const dirs=[];
  try { for (const e of (await fs.readdir(root,{withFileTypes:true})).slice(0,100)) if(e.isDirectory() && /^(arm-gnu-toolchain-|cmake-)/.test(e.name)) dirs.push(path.join(root,e.name,'bin')); } catch {}
  if(process.platform==='win32')dirs.push('C:\\TDM-GCC-64\\bin');
  env.PATH=[...dirs,original].join(path.delimiter);return env;
}
async function executable(names,env) {
  for(const name of names) for(const rawDir of env.PATH.split(path.delimiter).filter(Boolean)) {
    const dir=rawDir.trim().replace(/^"(.*)"$/, '$1');
    const p=path.resolve(dir,name+(process.platform==='win32'?'.exe':''));
    try {await fs.access(p,process.platform==='win32'?0:1);return p;} catch {}
  }
  throw new Error(`Required local tool not found: ${names.join(' / ')}. Add it to PATH or set BOBFLIGHT_TOOL_ROOT and restart the local configurator.`);
}
function run(command,args,ctx,timeout=120000) {
  if(ctx.signal?.aborted)return Promise.reject(new Error('Build cancelled.'));
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:ctx.repo,env:ctx.env,shell:false,windowsHide:true,detached:process.platform!=='win32'});
    let stopped=false,settled=false,output='';
    const collect=b=>{const text=b.toString();output=(output+text).slice(-262144);ctx.log?.(text);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const stop=()=>{if(stopped||settled)return;stopped=true;
      if(child.pid && process.platform==='win32') {
        const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.on('error',()=>child.kill());
      } else if(child.pid) {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    };
    const timer=setTimeout(stop,timeout);ctx.signal?.addEventListener('abort',stop,{once:true});
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);ctx.signal?.removeEventListener('abort',stop);error?reject(error):resolve(output);};
    child.on('error',e=>finish(e));child.on('close',code=>finish(stopped?new Error('Build cancelled or timed out. No artifact is usable.'):code!==0?new Error(`${path.basename(command)} failed (${code}). See build log.`):null));
  });
}
export async function compileHex(profile,{repo=REPO,signal,log=()=>{}}={}) {
  const env=await buildEnvironment(repo);const ctx={repo,env,signal,log};
  const git=await executable(['git'],env), python=await executable(process.platform==='win32'?['py','python','python3']:['python3','python'],env);
  const py=/^py(?:\.exe)?$/i.test(path.basename(python))?['-3']:[];
  const revision=async()=>{
    const sha=(await run(git,['rev-parse','HEAD'],{...ctx,log:null})).trim();
    if(!/^[0-9a-f]{40}$/.test(sha) || (await run(git,['status','--porcelain','--untracked-files=normal'],{...ctx,log:null})).trim())throw new Error('Build requires a clean committed checkout. Commit/revert source changes first; no older HEX will be reused.');
    return sha;
  };
  const sourceRevision=await revision();
  await executable(['arm-none-eabi-gcc'],env);await executable(['arm-none-eabi-objcopy'],env);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'bobflight-build-'));const firmware=path.join(repo,'bobflight-firmware');
  try {
    let image,fileName,manifest=null;
    if(profile.diagnostic) {
      await run(python,[...py,path.join(firmware,'tools/build_f405_usb_diagnostic.py'),'--out',temp],ctx,180000);
      image=path.join(temp,'bobflight-mltempf4-usb-diagnostic.hex');
      fileName=profile.boardId==='custom_f405xg_usb'?'bobflight-custom-f405xg-usb-diagnostic.hex':'bobflight-mltempf4-usb-diagnostic.hex';
    } else {
      const cmake=await executable(['cmake'],env);
      const make=await executable(process.platform==='win32'?['mingw32-make']:['make'],env);
      const resolved=JSON.parse(await run(python,[...py,path.join(firmware,'scripts/target_registry.py'),'resolve',profile.boardId,'--json','--hardware'],{...ctx,log:null}));
      if(resolved.board.id!==profile.boardId || !['cmake/stm32f745.cmake','cmake/stm32f722.cmake'].includes(resolved.toolchain))throw new Error('Target registry returned an unsupported build recipe.');
      const build=path.join(temp,'build');
      await run(cmake,['-S',firmware,'-B',build,'-G',process.platform==='win32'?'MinGW Makefiles':'Unix Makefiles',`-DCMAKE_MAKE_PROGRAM=${make}`,`-DCMAKE_TOOLCHAIN_FILE=${path.join(firmware,resolved.toolchain)}`,`-DBOBFLIGHT_BOARD=${profile.boardId}`,'-DBOBFLIGHT_HOST_SMOKE=OFF','-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF','-DBOBFLIGHT_PROVE_RESET=OFF','-DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF'],ctx);
      await run(cmake,['--build',build,'-j','2'],ctx,240000);
      await run(cmake,['--build',build,'--target','check_bootloader_image'],ctx);
      await run(python,[...py,path.join(firmware,'scripts/publish_target_image.py'),'--target',profile.boardId,'--hex',path.join(build,'bobflight.hex'),'--output',temp],ctx);
      const parent=path.join(temp,'artifacts',profile.boardId);const entries=await fs.readdir(parent);if(entries.length!==1)throw new Error('Ambiguous verified artifact.');
      fileName=`bobflight-${profile.boardId}-main.hex`;image=path.join(parent,entries[0],fileName);
      manifest=JSON.parse(await fs.readFile(image+'.json','utf8'));
      if(manifest.git_commit!==sourceRevision||manifest.tracked_source_dirty||manifest.board.id!==profile.boardId)throw new Error('Artifact provenance does not match this build.');
    }
    if((await fs.stat(image)).size>LIMIT)throw new Error('Generated HEX exceeds input limit.');
    const hex=await fs.readFile(image,'utf8');
    // Same parser and profile policy as the flasher, before offering any artifact.
    const {parseIntelHex}=require('../protocol/dist/flasher/intel-hex.js');
    const {validateF405DiagnosticImage}=require('../protocol/dist/flasher/f405-diagnostic.js');
    const parsed=parseIntelHex(hex);
    if(profile.diagnostic)validateF405DiagnosticImage(parsed);
    if(await revision()!==sourceRevision)throw new Error('Source revision changed during build. Discarding result.');
    if(signal?.aborted)throw new Error('Build cancelled.');
    return {fileName,hex,sha256:createHash('sha256').update(hex,'utf8').digest('hex'),sourceRevision,profile:profile.profile,label:profile.label,manifest,boardId:profile.boardId};
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}
function isLoopback(address) { return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address); }
function allowedRequest(req) {
  if(!isLoopback(req.socket.remoteAddress))return false;
  let host;try{host=new URL((req.socket.encrypted?'https://':'http://')+req.headers.host);}catch{return false;}
  if(!['localhost','127.0.0.1','[::1]'].includes(host.hostname)||host.username||host.password||host.pathname!=='/'||host.search||host.hash)return false;
  const origin=req.headers.origin;
  if(origin && origin!==host.origin)return false;
  if(req.headers['sec-fetch-site'] && req.headers['sec-fetch-site']!=='same-origin' && req.headers['sec-fetch-site']!=='none')return false;
  return true;
}
export function createBuildMiddleware({compile=compileHex}={}) {
  const token=randomBytes(32).toString('hex');let active=false;
  const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.end(JSON.stringify(data));};
  return async(req,res,next)=>{
    if(req.url?.split('?')[0]!=='/__bobflight_build'){next();return;}
    if(!allowedRequest(req)){json(res,403,{error:'Local builder accepts loopback, same-origin requests only.'});return;}
    if(req.method==='GET'){json(res,200,{protocol:1,token,boards:known,requirements:'ARM GCC/objcopy and Python 3; F7 additionally requires CMake, Make and PyYAML. Local trusted source only.'});return;}
    if(req.method!=='POST'){json(res,405,{error:'Method not allowed.'});return;}
    const supplied=req.headers['x-bobflight-build-token'];
    if(typeof supplied!=='string'||!/^[0-9a-f]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){json(res,403,{error:'Invalid local build token.'});return;}
    if(req.headers['content-type']!=='application/json'){json(res,415,{error:'JSON profile required.'});return;}
    if(active){json(res,409,{error:'Another local build is still running.'});return;}
    let input;
    try {let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096)throw new Error('Build request too large.');}input=JSON.parse(body);}catch{if(!res.destroyed)json(res,400,{error:'Invalid or oversized build request.'});return;}
    let profile;try{profile=resolveBuildProfile(input);}catch(e){json(res,400,{error:e.message});return;}
    // Check again after asynchronous body reading; two requests cannot both start.
    if(active){json(res,409,{error:'Another local build is still running.'});return;}active=true;
    const controller=new AbortController();let log='';const timer=setTimeout(()=>controller.abort(),360000);
    const close=()=>{if(!res.writableEnded)controller.abort();};res.once('close',close);
    try {const result=await compile(profile,{signal:controller.signal,log:text=>{log=(log+text).slice(-262144);}});if(!res.destroyed)json(res,200,{...result,log});}
    catch(e){if(!res.destroyed)json(res,422,{error:e.message||'Build failed.',log});}
    finally{clearTimeout(timer);res.off('close',close);active=false;}
  };
}
export function localHexBuilderPlugin() {
  return {name:'bobflight-local-hex-builder',apply:'serve',configureServer(server){server.middlewares.use(createBuildMiddleware());}};
}
