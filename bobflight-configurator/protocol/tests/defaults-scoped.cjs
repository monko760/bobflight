/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/* Scoped defaults (D1) protocol layer: the frozen `defaults pid|rates|filters` reply parser never assumes success,
 * keeps FW error lines verbatim (prefix match, unknown future codes too), the client allowlists exactly the three
 * group commands, ends the reply on the end/error line, and the mock FC answers in the frozen FW shape. */
const assert=require('node:assert/strict');
const P=require('../dist');
const {parseDefaultsGroupReply:parse,DEFAULTS_GROUP_KEYS:KEYS,DEFAULTS_GROUPS,DEFAULTS_ERROR_CODES,DEFAULTS_RESULT_UNKNOWN,isDefaultsReplyEnd,isDefaultsCliCommand,
  mockDefaultsReply,DEFAULTS_MOCK_ERROR_LINES:ERR,MOCK_BARE_DEFAULTS_REPLY,BobFlightCliClient,MockTransportFactory,MockSerial,DEFAULT_SETTINGS,SETTINGS_KEYS}=P;
let tests=0;const test=async(name,fn)=>{await fn();tests++;console.log('ok -',name);};
const crlf=ls=>ls.map(l=>l+'\r\n').join('');

(async()=>{
await test('key lists: exact FW names and counts (pid 11, rates 9, filters 9), all real settings keys',()=>{
  assert.deepEqual(DEFAULTS_GROUPS,['pid','rates','filters']);
  assert.equal(KEYS.pid.length,11);assert.equal(KEYS.rates.length,9);assert.equal(KEYS.filters.length,9);
  assert.deepEqual([...KEYS.pid],['pid_roll_p','pid_roll_i','pid_roll_d','pid_pitch_p','pid_pitch_i','pid_pitch_d','pid_yaw_p','pid_yaw_i','pid_yaw_d','min_throttle','airmode']);
  assert.deepEqual([...KEYS.rates],['rate_center_roll','rate_center_pitch','rate_center_yaw','rate_max_roll','rate_max_pitch','rate_max_yaw','rate_expo_roll','rate_expo_pitch','rate_expo_yaw']);
  assert.deepEqual([...KEYS.filters],['gyro_lpf_hz','dterm_lpf_hz','gyro_notch1_hz','gyro_notch1_cutoff_hz','gyro_notch2_hz','gyro_notch2_cutoff_hz','rpm_filter_harmonics','rpm_filter_min_hz','rpm_filter_q_x100']);
  for(const g of DEFAULTS_GROUPS)for(const k of KEYS[g])assert.ok(SETTINGS_KEYS.includes(k),k);
  const all=[...KEYS.pid,...KEYS.rates,...KEYS.filters];assert.equal(new Set(all).size,29,'no key in two groups');
  for(const k of ['motor_poles','loop_rate_hz','motor_direction','align_board_roll'])assert.ok(!all.includes(k),`${k} is never reset by a scoped group`);
});
await test('every key name exists in the FW on this branch (config.c defaults lookup), so the confirm dialog uses exact FW names',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const cfg=fs.readFileSync(path.resolve(__dirname,'../../../bobflight-firmware/src/flight/config.c'),'utf8');
  const gn=fs.readFileSync(path.resolve(__dirname,'../../../bobflight-firmware/src/drivers/cli.c'),'utf8');
  for(const g of DEFAULTS_GROUPS)for(const k of KEYS[g])assert.ok(cfg.includes(`"${k}"`)||gn.includes(`"${k}"`),`${k} named in FW config.c/cli.c`);
});
await test('ok frame per group: keys verbatim, count and group checked',()=>{
  for(const g of DEFAULTS_GROUPS){const r=parse(mockDefaultsReply(g,'ok'),g);
    assert.equal(r.kind,'ok',g);assert.equal(r.group,g);assert.equal(r.count,KEYS[g].length);
    assert.deepEqual(r.keys.map(k=>k.key),[...KEYS[g]]);
    for(const k of r.keys){assert.equal(k.line,`defaults_key: ${k.key}=${k.value}`);assert.equal(k.value,DEFAULT_SETTINGS[k.key],k.key);}
    assert.deepEqual(r.keyLines,mockDefaultsReply(g,'ok').split('\r\n').filter(l=>l.startsWith('defaults_key:')));}
  const pid=parse(mockDefaultsReply('pid'),'pid');assert.ok(pid.keyLines.includes('defaults_key: pid_yaw_d=5e-05'),'%.6g value kept verbatim');
  assert.ok(pid.keyLines.includes('defaults_key: airmode=0'));
});
await test('missing defaults_end -> unknown (never success)',()=>{
  for(const g of DEFAULTS_GROUPS){const r=parse(mockDefaultsReply(g,'missing_end'),g);assert.equal(r.kind,'unknown');assert.match(r.reason,/defaults_end line missing/);assert.equal(r.keyLines.length,KEYS[g].length,'key lines kept for display');}
  assert.equal(parse(crlf(['defaults_group: pid']),'pid').kind,'unknown');
  assert.equal(parse('','pid').kind,'unknown');
  assert.equal(parse(crlf(['defaults_group: pid','defaults_key: pid_roll_p=0.002','defaults_end: pid']),'pid').kind,'unknown','end without count');
});
await test('count mismatch -> unknown, both directions and non-numeric counts',()=>{
  for(const g of DEFAULTS_GROUPS){const r=parse(mockDefaultsReply(g,'count_mismatch'),g);assert.equal(r.kind,'unknown');assert.match(r.reason,/count mismatch/);}
  const k=['defaults_key: pid_roll_p=0.002','defaults_key: pid_roll_i=0.001'];
  assert.equal(parse(crlf(['defaults_group: pid',...k,'defaults_end: pid 1']),'pid').kind,'unknown','fewer counted than sent');
  assert.equal(parse(crlf(['defaults_group: pid',...k,'defaults_end: pid 3']),'pid').kind,'unknown','more counted than sent');
  assert.equal(parse(crlf(['defaults_group: pid',...k,'defaults_end: pid 2']),'pid').kind,'ok','consistent frame');
  for(const c of ['02','2.0','-2','two','0x2'])assert.equal(parse(crlf(['defaults_group: pid',...k,`defaults_end: pid ${c}`]),'pid').kind,'unknown',c);
});
await test('group mismatch (group line or end line) -> unknown',()=>{
  for(const g of DEFAULTS_GROUPS){const r=parse(mockDefaultsReply(g,'group_mismatch'),g);assert.equal(r.kind,'unknown');assert.match(r.reason,/group mismatch/);}
  assert.equal(parse(mockDefaultsReply('rates'),'pid').kind,'unknown','a rates frame is never a pid success');
  assert.equal(parse(crlf(['defaults_group: pid','defaults_key: pid_roll_p=0.002','defaults_end: rates 1']),'pid').kind,'unknown');
});
await test('malformed, duplicate or stray lines -> unknown',()=>{
  const bad=[['defaults_group: pid','defaults_key: pid_roll_p 0.002','defaults_end: pid 1'],
    ['defaults_group: pid','defaults_key: pid_roll_p=0.002','defaults_key: pid_roll_p=0.002','defaults_end: pid 2'],
    ['defaults_group: pid','defaults restored','defaults_end: pid 0'],
    ['BobFlight 0.1.0 ready','defaults_group: pid','defaults_end: pid 0'],
    ['defaults_key: pid_roll_p=0.002','defaults_group: pid','defaults_end: pid 1'],
    ['defaults restored']];
  for(const b of bad)assert.equal(parse(crlf(b),'pid').kind,'unknown',JSON.stringify(b));
  assert.equal(DEFAULTS_RESULT_UNKNOWN,'Defaults result unknown, re-read');
});
await test('every defaults_error line verbatim by prefix, unknown future codes too',()=>{
  for(const code of DEFAULTS_ERROR_CODES){const line=ERR[code];assert.ok(line.startsWith(`defaults_error: ${code}`));
    const r=parse(line+'\r\n','pid');assert.deepEqual({kind:r.kind,line:r.line,code:r.code,known:r.known},{kind:'error',line,code,known:true});}
  for(const line of ['defaults_error: armed','defaults_error: bench_active motors spinning','defaults_error: group_required ...']){const r=parse(line+'\r\n','rates');assert.equal(r.kind,'error');assert.equal(r.line,line,'whole line, tail not pinned');}
  const f=parse(ERR.future_error+'\r\n','filters');assert.equal(f.kind,'error');assert.equal(f.line,ERR.future_error);assert.equal(f.known,false);assert.equal(f.code,'storage_locked_v2');
  assert.equal(parse('defaults_error:\r\n','pid').kind,'error','an empty code is still an FC error line');
  assert.equal(parse(crlf(['defaults_group: pid','defaults_error: armed']),'pid').kind,'error','an error line anywhere wins');
});
await test('Blackbox-recording refusal (`command refused: ...`, the whole reply) is an FC refusal shown verbatim, not unknown',()=>{
  const line=ERR.blackbox_refused;assert.ok(line.startsWith(P.FC_COMMAND_REFUSED_PREFIX));
  const r=parse(line+'\r\n','filters');assert.deepEqual({kind:r.kind,line:r.line},{kind:'error',line});
  assert.ok(isDefaultsReplyEnd(line),'ends the reply at once');
  assert.equal(parse(crlf(['defaults_group: pid',line]),'pid').kind,'unknown','only as the whole reply');
});
await test('older FC (unknown command) -> unsupported with the line verbatim',()=>{
  const r=parse(mockDefaultsReply('pid','unsupported'),'pid');assert.deepEqual({kind:r.kind,line:r.line},{kind:'unsupported',line:'unknown — try help'});
});
await test('reply end detection: end line, error line, unknown command; not key/group lines',()=>{
  for(const l of ['defaults_end: pid 11','defaults_error: armed','defaults_error: anything new','unknown — try help'])assert.ok(isDefaultsReplyEnd(l),l);
  for(const l of ['defaults_group: pid','defaults_key: airmode=0','defaults_end: pid','defaults restored'])assert.ok(!isDefaultsReplyEnd(l),l);
});
await test('client allowlist: exactly defaults pid|rates|filters; bare/other groups refused before the wire',async()=>{
  for(const c of ['defaults pid','defaults rates','defaults filters'])assert.ok(isDefaultsCliCommand(c));
  for(const c of ['defaults','defaults all','defaults PID','defaults pid ','defaults pid rates','defaults motors'])assert.ok(!isDefaultsCliCommand(c),c);
  const client=new BobFlightCliClient(new MockTransportFactory());await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,30));
  client.clearSentCommands();
  for(const c of ['defaults','defaults all','defaults motors','defaults pid\nsave'])await assert.rejects(client.sendCommand(c),/unsupported CLI command/,c);
  await assert.rejects(client.restoreDefaultsGroup('all'),/unsupported defaults group/);
  assert.deepEqual([...client.getSentCommands()],[],'nothing reached the wire');
  await client.disconnect();
});
let port=null;class F extends MockTransportFactory{async open(o){port=await super.open(o);return port;}}
async function connect(opts){const client=new BobFlightCliClient(new F(opts));await client.connect({path:'mock://bobflight',transport:'mock'});await new Promise(r=>setTimeout(r,30));client.clearSentCommands();return client;}
await test('mock FC + client: each group resets only its keys, frozen shape, no save sent',async()=>{
  const client=await connect({loopRateScenario:'8000/2'});
  const changed={pid_roll_p:'0.009',rate_max_roll:'1200',gyro_lpf_hz:'200',gyro_notch1_cutoff_hz:'150',gyro_notch1_hz:'200',rpm_filter_harmonics:'2',motor_poles:'12',loop_rate_hz:null};
  for(const [k,v] of Object.entries(changed))if(v!==null)await client.setSetting(k,v);
  const lr=(await client.sendCommand('set loop_rate_hz 1000')).trim();assert.match(lr,/loop_rate_hz=1000/,lr);
  const pid=await client.restoreDefaultsGroup('pid');assert.equal(pid.kind,'ok');assert.equal(pid.count,11);
  let all=await client.getAllSettings();assert.equal(all.pid_roll_p,'0.002');assert.equal(all.rate_max_roll,'1200','rates untouched by pid');assert.equal(all.gyro_lpf_hz,'200');
  const rates=await client.restoreDefaultsGroup('rates');assert.equal(rates.kind,'ok');assert.equal(rates.count,9);
  all=await client.getAllSettings();assert.equal(all.rate_max_roll,'800');assert.equal(all.gyro_lpf_hz,'200','filters untouched by rates');
  const filters=await client.restoreDefaultsGroup('filters');assert.equal(filters.kind,'ok');assert.equal(filters.count,9);
  all=await client.getAllSettings();
  assert.equal(all.gyro_lpf_hz,'320');assert.equal(all.gyro_notch1_hz,'0');assert.equal(all.gyro_notch1_cutoff_hz,'0');assert.equal(all.rpm_filter_harmonics,'0');
  assert.equal(all.motor_poles,'12','motor_poles is not a filters key');
  assert.equal((await client.sendCommand('get loop_rate_hz')).trim(),'loop_rate_hz=1000','loop rate untouched');
  const sent=[...client.getSentCommands()];
  assert.ok(sent.includes('defaults pid')&&sent.includes('defaults rates')&&sent.includes('defaults filters'));
  assert.ok(!sent.includes('save')&&!sent.includes('defaults'),'never save, never bare defaults');
  await client.disconnect();
});
await test('mock FC: armed / bench refusals and every scenario through the client',async()=>{
  const client=await connect({gyroHealthy:true});
  assert.equal((await client.sendCommand('arm')).trim(),'armed');
  const a=await client.restoreDefaultsGroup('pid');assert.deepEqual({kind:a.kind,line:a.line},{kind:'error',line:ERR.armed});
  await client.sendCommand('disarm');
  for(const s of ['bench_active','calibration_active','unknown_group','group_required','future_error','blackbox_refused']){port.defaultsScenario=s;const r=await client.restoreDefaultsGroup('rates');assert.equal(r.kind,'error',s);assert.equal(r.line,ERR[s]);}
  for(const s of ['missing_end','count_mismatch','group_mismatch']){port.defaultsScenario=s;const r=await client.restoreDefaultsGroup('filters');assert.equal(r.kind,'unknown',s);}
  port.defaultsScenario='unsupported';assert.equal((await client.restoreDefaultsGroup('pid')).kind,'unsupported');
  port.defaultsScenario='ok';
  await assert.rejects(client.restoreDefaults(),e=>e.message===ERR.group_required,'bare defaults: group_required thrown verbatim');
  assert.equal(MOCK_BARE_DEFAULTS_REPLY,ERR.group_required+'\r\n');
  await client.disconnect();
});
await test('reply ends on defaults_end without waiting for idle; missing end resolves after the idle gap',async()=>{
  const client=await connect();
  let t=Date.now();assert.equal((await client.restoreDefaultsGroup('pid')).kind,'ok');const fast=Date.now()-t;
  port.defaultsScenario='missing_end';t=Date.now();assert.equal((await client.restoreDefaultsGroup('pid')).kind,'unknown');const slow=Date.now()-t;
  assert.ok(fast<P.DEFAULTS_REPLY_IDLE_MS,`end line finishes early (${fast} ms)`);assert.ok(slow>=P.DEFAULTS_REPLY_IDLE_MS-20,`no end line: idle gap (${slow} ms)`);
  await client.disconnect();
});
// ---- REAL host firmware (the CI contract build) -----------------------------------
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const fwRoot=path.resolve(__dirname,'../../../bobflight-firmware');
const binary=process.env.BOBFLIGHT_HOST_BIN?path.resolve(process.env.BOBFLIGHT_HOST_BIN):path.join(fwRoot,'build-contract/bobflight_host');
await test('FW source on this branch: exact refusal strings and group key tables match this client',()=>{
  const dcli=fs.readFileSync(path.join(fwRoot,'src/drivers/defaults_cli.h'),'utf8');
  for(const c of ['armed','bench_active','calibration_active','unknown_group'])assert.ok(dcli.includes(`cli_write_str("${ERR[c]}\\r\\n")`),`FW prints ${ERR[c]}`);
  assert.ok(dcli.includes(`cli_write_str("${ERR.group_required}\\r\\n")`),'FW group_required line');
  assert.ok(dcli.includes('"defaults_group: %s\\r\\n"')&&dcli.includes('"defaults_end: %s %u\\r\\n"')&&dcli.includes('"defaults_key: "'),'FW frame lines');
  const bb=fs.readFileSync(path.join(fwRoot,'src/drivers/blackbox_cli.h'),'utf8');assert.ok(bb.includes(`cli_write_str("${ERR.blackbox_refused}\\r\\n")`),'FW Blackbox refusal line');
  const cfg=fs.readFileSync(path.join(fwRoot,'src/flight/config.c'),'utf8');
  for(const g of DEFAULTS_GROUPS){const m=new RegExp(`g_group_${g}\\[\\]=\\{([^}]*)\\}`).exec(cfg);assert.ok(m,`FW table g_group_${g}`);
    assert.deepEqual(m[1].match(/"[a-z0-9_]+"/g).map(x=>x.slice(1,-1)),[...KEYS[g]],`${g}: FW key table == DEFAULTS_GROUP_KEYS (names and order)`);}
});
const host=(cmds)=>{const r=spawnSync(binary,[],{input:cmds.join('\n')+'\n',encoding:'utf8',maxBuffer:1<<20});assert.equal(r.status,0,r.stderr);return r.stdout;};
if(!fs.existsSync(binary)&&process.env.DEFAULTS_ALLOW_NO_HOST==='1')console.log(`skip - real host firmware tests (no ${binary})`);
else{
  assert.ok(fs.existsSync(binary),`real host firmware binary missing: ${binary} (CI builds it in the contract step; set DEFAULTS_ALLOW_NO_HOST=1 to skip locally)`);
  const frame=(out,g)=>{const m=new RegExp(`defaults_group: ${g}\\r\\n(?:defaults_key: [^\\r\\n]+\\r\\n)*defaults_end: ${g} \\d+\\r\\n`).exec(out);assert.ok(m,`frame for ${g} in: ${out.slice(-800)}`);return m[0];};
  await test('real host FW replies parse as ok with this parser; the mock FC sends byte-identical frames',()=>{
    for(const g of DEFAULTS_GROUPS){
      const real=frame(host(['set pid_roll_p 0.004','set rate_max_yaw 700','set gyro_lpf_hz 250',`defaults ${g}`]),g);
      const r=parse(real,g);assert.equal(r.kind,'ok',`${g}: ${r.reason}`);assert.equal(r.count,KEYS[g].length);assert.deepEqual(r.keys.map(k=>k.key),[...KEYS[g]]);
      assert.equal(mockDefaultsReply(g,'ok'),real,`${g}: mock fixture == real FW bytes`);
      assert.equal(parse(real,g==='pid'?'rates':'pid').kind,'unknown','real frame for another group is never success');
    }
  });
  await test('real host FW refusals: bare defaults and an unknown group are the exact single lines this client shows verbatim',()=>{
    const bare=host(['defaults']),bogus=host(['defaults bogus']);
    assert.ok(bare.includes(`\r\n${ERR.group_required}\r\n`)||bare.startsWith(`${ERR.group_required}\r\n`),bare.slice(-300));
    assert.ok(bogus.includes(`\r\n${ERR.unknown_group}\r\n`)||bogus.startsWith(`${ERR.unknown_group}\r\n`),bogus.slice(-300));
    assert.equal(parse(ERR.group_required+'\r\n','pid').line,ERR.group_required);
    assert.equal(MOCK_BARE_DEFAULTS_REPLY,ERR.group_required+'\r\n');
    // The mock FC answers the same lines.
  });
  await test('accel_cal_saved (D1, shown next to Save): real host reply "no" verbatim; "yes"; missing/repeated/unknown value -> unknown; parseStorage snapshot unchanged',()=>{
    const real=/storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/.exec(host(['set align_board_roll 90','save','storage']))[0];
    assert.match(real,/\r\naccel_cal_saved: no\r\nstorage_end: 1\r\n$/,'real host: no saved accel calibration, line just before storage_end');
    assert.deepEqual(P.readAccelCalSaved(real),{value:'no',line:'accel_cal_saved: no'});
    const yes=real.replace('accel_cal_saved: no','accel_cal_saved: yes');assert.deepEqual(P.readAccelCalSaved(yes),{value:'yes',line:'accel_cal_saved: yes'});
    const missing=real.replace('accel_cal_saved: no\r\n','');assert.deepEqual(P.readAccelCalSaved(missing),{value:'unknown',line:null});
    assert.deepEqual(P.readAccelCalSaved(real.replace(/\r\n/g,'\n')),{value:'no',line:'accel_cal_saved: no'},'LF too');
    assert.deepEqual(P.readAccelCalSaved(real.replace('accel_cal_saved: no','accel_cal_saved: pending')),{value:'unknown',line:'accel_cal_saved: pending'},'unknown value: line verbatim, value unknown');
    assert.deepEqual(P.readAccelCalSaved(real.replace('accel_cal_saved: no','accel_cal_saved: yes\r\naccel_cal_saved: no')),{value:'unknown',line:null},'repeated -> unknown');
    assert.deepEqual(P.parseStorage(real),P.parseStorage(missing),'storage snapshot unchanged by the line');
  });
  await test('real host FW: defaults reset only the group, never save; storage dirty is RAM-vs-flash (accel_cal_saved just before storage_end parses)',()=>{
    const out=host(['set pid_roll_p 0.004','set rate_max_yaw 700','set gyro_lpf_hz 250','save','storage','defaults pid','storage','get pid_roll_p','get rate_max_yaw','get gyro_lpf_hz','get motor_poles']);
    const st=[...out.matchAll(/storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/g)].map(m=>m[0]);assert.equal(st.length,2);
    for(const x of st)assert.match(x,/\r\naccel_cal_saved: (yes|no)\r\nstorage_end: 1\r\n$/,'accel_cal_saved just before storage_end');
    const [a,b]=st.map(P.parseStorage);assert.equal(a.dirty,false,'clean after save');assert.equal(b.dirty,true,'defaults pid differs from the saved pid -> dirty');
    assert.match(out,/\r\npid_roll_p=0\.002\r\n/);assert.match(out,/\r\nrate_max_yaw=700\r\n/);assert.match(out,/\r\ngyro_lpf_hz=250\r\n/);
    assert.ok(!/\r\nsaved:/.test(out.slice(out.indexOf('defaults_group: pid'))),'no save after defaults');
    const clean=host(['set pid_roll_p 0.004','save','set rate_max_yaw 700','defaults rates','storage']);
    const c=P.parseStorage(/storage_api: 1\r\n[\s\S]*?storage_end: 1\r\n/.exec(clean)[0]);
    assert.equal(c.dirty,false,'defaults equal to the saved values -> FW reports clean (the UI shows the FC flag, never a guess)');
  });
}
console.log(`defaults-scoped protocol: ${tests} tests passed`);
})().catch(e=>{console.error(e);process.exit(1);});
