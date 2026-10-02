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
