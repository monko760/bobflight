/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/* motor_direction (schema 10) protocol: parsers keep FC tokens verbatim, unknown for anything missing or
 * malformed, only the two known tokens become commands, and the mock answers the FW lines exactly. */
const assert=require('node:assert/strict');
const P=require('../dist');
const {parseMotorDirectionGetReply:get,parseMotorDirectionSetReply:set,parseMixerReport:mixer,motorDirectionView:view,motorDirectionSetCommand:cmd,
  MockMotorDirection,MOTOR_DIRECTION_MOCK_SCENARIOS,MOTOR_DIRECTION_ARMED_LINE,MOTOR_DIRECTION_MOTOR_TEST_LINE,MOTOR_DIRECTION_INVALID_LINE,isMotorDirectionCliCommand}=P;
assert.equal(MOTOR_DIRECTION_ARMED_LINE,'set failed: armed');
assert.equal(MOTOR_DIRECTION_MOTOR_TEST_LINE,'set failed: motor test running');
assert.equal(MOTOR_DIRECTION_INVALID_LINE,'set failed: motor_direction must be props-out or props-in');
assert.deepEqual(get('motor_direction=props-in\r\n'),{kind:'value',token:'props-in'});
assert.deepEqual(get('motor_direction=props-mixed\r\n'),{kind:'value',token:'props-mixed'},'future token verbatim');
assert.deepEqual(get('unknown key\r\n'),{kind:'unsupported'});
for(const bad of ['motor_direction=\r\n','motor_direction=Props-In\r\n','motor_direction=props-in\r\nmotor_direction=props-out\r\n','','garbage'])assert.equal(get(bad).kind,'malformed',JSON.stringify(bad));
assert.deepEqual(set('ok motor_direction=props-in\r\n','props-in'),{ok:true,token:'props-in'});
assert.deepEqual(set('ok motor_direction=props-out\r\n','props-in'),{ok:false,unsupported:false,line:'ok motor_direction=props-out'},'echo must match the request');
for(const l of [MOTOR_DIRECTION_ARMED_LINE,MOTOR_DIRECTION_MOTOR_TEST_LINE,MOTOR_DIRECTION_INVALID_LINE])assert.deepEqual(set(l+'\r\n','props-in'),{ok:false,unsupported:false,line:l});
assert.deepEqual(set('unknown key\r\n','props-in'),{ok:false,unsupported:true,line:'unknown key'});
const rep=l=>['mixer_api: 1',...l,'mixer_end: 1'].join('\r\n')+'\r\n';
assert.deepEqual(mixer(new MockMotorDirection('props-out').report()),{mixer:'quadx',motorDirection:'props-out',yaw:['-1','+1','+1','-1']});
assert.deepEqual(mixer(new MockMotorDirection('props-in').report()),{mixer:'quadx',motorDirection:'props-in',yaw:['+1','-1','-1','+1']});
assert.equal(mixer('mixer: quadx\r\nmixer_end: 1\r\n'),null,'unframed');
assert.deepEqual(mixer(rep(['mixer: quadx','motor_direction: props-in','motor_direction: props-in','mixer_yaw_m1: 1','mixer_yaw_m2: +1.0'])),{mixer:'quadx',motorDirection:null,yaw:[null,null,null,null]},'duplicate/malformed -> null');
assert.deepEqual(view(null,null),{supported:null,held:'unknown',selected:null,mixerDirection:'unknown',yaw:['unknown','unknown','unknown','unknown']});
assert.deepEqual(view({kind:'unsupported'},null).supported,false);
assert.deepEqual(view({kind:'value',token:'props-mixed'},null),{supported:true,held:'props-mixed',selected:null,mixerDirection:'unknown',yaw:['unknown','unknown','unknown','unknown']});
// Only a real value reply enables the selector (Config Lead #63 item 2): malformed is NOT supported.
for(const bad of ['motor_direction=\r\n','BobFlight 0.1.0 ready\r\nmotor_direction=props-out\r\n','garbage','']){const g=get(bad);assert.equal(g.kind,'malformed',JSON.stringify(bad));assert.equal(view(g,null).supported,null,'malformed -> supported unknown: '+JSON.stringify(bad));assert.equal(view(g,null).held,'unknown');}
assert.equal(view({kind:'value',token:'props-in'},null).supported,true);
// An empty set reply is not an FC refusal line (kept out of the refusal slot).
assert.deepEqual(set('','props-in'),{ok:false,unsupported:false,line:null});
assert.deepEqual(set('\r\n','props-in'),{ok:false,unsupported:false,line:null});
// E1: a schema this Configurator does not know (11) is refused even when the diff holds only
// default-valued lines (no `set` line to trip a per-key check).
{const {parseConfigurationExport:pce,STORAGE_SCOPE_V13}=P;
 const exp=(schema,scope)=>['# bobflight_config: 1','# board: kakute_f7_hdv','# firmware: 0.1.0','# kind: diff',`# schema: ${schema}`,`# scope: ${scope}`,'# excludes: gyro_calibration','# mode_count: 4',
  '# accel_calibrated: no','# calibration_restore: metadata-only-recalibrate-if-flash-lost','# accel_storage: not-calibrated','# accel_bias: 0 0 0','# accel_scale: 1 1 1','# config_end: 1'].join('\r\n')+'\r\n';
 assert.equal(pce(exp('13',STORAGE_SCOPE_V13),'diff').kind,'diff','minimal schema13 diff parses');
 assert.throws(()=>pce(exp('11',STORAGE_SCOPE_V13),'diff'),/Unsupported export identity\/schema/,'schema 11, schema 10 scope');
 assert.throws(()=>pce(exp('11',STORAGE_SCOPE_V13+',gyro_rate_hz'),'diff'),/Unsupported export identity\/schema/,'schema 11 with a G1-style scope');}
assert.equal(cmd('props-in'),'set motor_direction props-in');assert.throws(()=>cmd('props-mixed'));
for(const c of ['get motor_direction','set motor_direction props-out','set motor_direction props-in','mixer'])assert.ok(isMotorDirectionCliCommand(c));
assert.ok(!isMotorDirectionCliCommand('set motor_direction props-mixed'));
// Mock: FW-identical lines, value unchanged after every refusal, defaults -> props-out.
{const m=new MockMotorDirection('props-out');
 assert.equal(m.handle('set motor_direction props-in',true),'set failed: armed\r\n');
 assert.equal(m.handle('set motor_direction props-in',false,true),'set failed: motor test running\r\n');
 assert.equal(m.handle('set motor_direction sideways',false),MOTOR_DIRECTION_INVALID_LINE+'\r\n');
 assert.equal(m.handle('set motor_direction',false),'set failed\r\n');
 assert.equal(m.handle('get motor_direction',false),'motor_direction=props-out\r\n');
 assert.equal(m.handle('set motor_direction props-in',false),'ok motor_direction=props-in\r\n');
 assert.equal(m.handle('get motor_direction',false),'motor_direction=props-in\r\n');
 m.defaults();assert.equal(m.value(),'props-out');}
for(const s of MOTOR_DIRECTION_MOCK_SCENARIOS){const m=new MockMotorDirection(s);const before=m.value();m.handle('set motor_direction props-in',false);
 if(s==='refused-armed'||s==='refused-motor-test'||s==='old-fc')assert.equal(m.value(),before,s);}
assert.equal(new MockMotorDirection('old-fc').handle('get motor_direction',false),'unknown key\r\n');
assert.equal(new MockMotorDirection('old-fc').handle('mixer',false),'unknown — try help\r\n');
console.log('PASS motor_direction protocol: tokens verbatim (future token kept), unknown for missing/duplicate/malformed, exact refusal lines, only props-out/props-in sendable, mock refusals keep the value');
