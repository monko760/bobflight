import assert from 'node:assert/strict';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {installFakeDom} from './fixtures/fakeDom';
import {SensorsPage} from '../src/pages/SensorsPage';
import {setSnapshot,calls,setFailure,setConditions} from './fixtures/calibrationUiStub';
import {aircraftProjection,QUADX_MOTORS} from '../src/sensors/aircraftView';
import type {SensorSnapshot} from '../src/sensors/telemetry';
const {container}=installFakeDom();const root=createRoot(container as never);
const base:SensorSnapshot={sensors_version:1,sample_seq:1,sample_ms:1,sensor_age_ms:0,gyro_ok:true,gyro_calibrated:true,accel_calibrated:false,gyro_dps:[0,0,0],accel_g:[0,0,.87],accel_raw_g:[0,0,.87],attitude_deg:[0,0,0],attitude_ready:true,arm:'disarmed',motor_active:false,cal_state:'idle',cal_manual:false,cal_samples:0,cal_required:0,cal_faces:0,cal_face:-1,cal_reason:'idle',calibration_storage:'not-calibrated',sensor_config_ok:true,calibration_api:2,cal_accel_level_supported:true,gyro_bias_applied:true};
function render(overrides:Partial<SensorSnapshot>={}){setSnapshot({...base,...overrides});flushSync(()=>root.render(<SensorsPage/>));}
function button(label:string){const el=container.findAll(e=>e.tagName==='BUTTON'&&e.textContent===label)[0];assert.ok(el,label);return el;}
function disabled(label:string){const el=button(label);return el.disabled||el.hasAttribute('disabled');}
function click(label:string){const b=button(label);assert(!disabled(label));const k=Object.keys(b).find(k=>k.startsWith('__reactProps$'));assert.ok(k);(b as any)[k].onClick();}
const settle=async()=>{await new Promise(r=>setImmediate(r));flushSync(()=>{});};
try {
 // Renderer is telemetry-only. Rotating it must never send motor/config commands.
 const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);
 const nose=(yaw:number)=>aircraftProjection(0,0,yaw)(145,0);
 near(nose(0)[0],240);assert(nose(0)[1]<160);
 assert(nose(90)[0]>240);near(nose(90)[1],160);
 near(nose(180)[0],240);assert(nose(180)[1]>160);
 assert(nose(-90)[0]<240);near(nose(-90)[1],160);
 assert.deepEqual(QUADX_MOTORS.map(m=>[m.number,m.position]),[[1,'rear-right'],[2,'front-right'],[3,'rear-left'],[4,'front-left']]);
 // Independent expanded rotation matrix catches applying yaw before body tilt.
 const rad=Math.PI/180,r=30*rad,p=20*rad,y=75*rad,x=90,v=-90;
 const worldX=x*Math.cos(y)*Math.cos(p)+v*(Math.cos(y)*Math.sin(p)*Math.sin(r)-Math.sin(y)*Math.cos(r));
 const worldY=x*Math.sin(y)*Math.cos(p)+v*(Math.sin(y)*Math.sin(p)*Math.sin(r)+Math.cos(y)*Math.cos(r));
 const worldZ=-x*Math.sin(p)+v*Math.cos(p)*Math.sin(r);
 const projected=aircraftProjection(30,20,75)(x,v);near(projected[0],240+worldY*.88);near(projected[1],160-worldX*.58+worldZ*.7);
 const find=(key:string,value:string)=>container.findAll(e=>e.getAttribute(key)===value)[0];
 for(const yaw of [0,90,180,-90]){
  render({yaw_reference:'gyro-relative',attitude_deg:[0,0,yaw]});
  for(const m of QUADX_MOTORS){assert.equal(find('data-motor',String(m.number)).getAttribute('data-position'),m.position);assert.equal(find('data-label',`motor-${m.number}`).textContent,`M${m.number}`);}
  assert.equal(find('data-label','front').textContent,'FRONT');assert.equal(find('data-label','back').textContent,'BACK');
  assert.equal(find('data-yaw-readout','true').textContent,`${yaw.toFixed(1)}°`);
  assert.equal(find('data-aircraft-view','true').getAttribute('data-attitude-ready'),'true');
  assert.deepEqual(calls,[]);
 }
 for(const roll of [0,45,90,180])for(const pitch of [-40,0,45]){
  render({yaw_reference:'gyro-relative',attitude_deg:[roll,pitch,90]});
  const labels=container.findAll(e=>e.hasAttribute('data-label')).map(g=>g.findAll(e=>e.tagName.toUpperCase()==='RECT')[0]);assert.equal(labels.length,6);
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
   const dx=Math.abs(Number(labels[i].getAttribute('x'))-Number(labels[j].getAttribute('x'))),dy=Math.abs(Number(labels[i].getAttribute('y'))-Number(labels[j].getAttribute('y')));
   assert(dx>=60||dy>=24,'motor/direction labels must remain separate');
  }
 }
 render({yaw_reference:undefined,attitude_deg:[0,0,50]});assert.equal(find('data-yaw-readout','true').textContent,'—');assert.ok(container.textContent.includes('update the controller firmware'));
 for(const conditions of [{fresh:false},{connected:false}]){
  setConditions(conditions);render({yaw_reference:'gyro-relative',attitude_deg:[0,0,90]});assert.equal(find('data-aircraft-view','true').getAttribute('data-attitude-ready'),'false');assert.equal(container.findAll(e=>e.hasAttribute('data-motor')).length,0);assert.equal(find('data-yaw-readout','true').textContent,'—');setConditions();
 }
 for(const overrides of [{attitude_ready:false},{gyro_ok:false},{attitude_deg:[0,0,NaN] as [number,number,number]}]){
  render({yaw_reference:'gyro-relative',...overrides});assert.equal(find('data-aircraft-view','true').getAttribute('data-attitude-ready'),'false');
 }
 console.log('PASS rendered aircraft: quarter-turn yaw, body-to-world tilt order, logical M1-M4, front/back, nonoverlapping labels, legacy/stale/disconnect/invalid refusal, no commands');
 render();assert.equal(disabled('Calibrate accelerometer level'),false);
 const b=button('Calibrate accelerometer level');const key=Object.keys(b).find(k=>k.startsWith('__reactProps$'));assert.ok(key);(b as any)[key].onClick();assert.deepEqual(calls,['calibrate_accel level']);
 assert.equal(container.findAll(e=>e.tagName==='DETAILS')[0].hasAttribute('open'),false);
 render({calibration_api:undefined,cal_accel_level_supported:undefined});assert.equal(disabled('Calibrate accelerometer level'),true);assert.ok(container.textContent.includes('does not advertise level calibration'));
 render({accel_raw_g:[0,0,-.876]});assert.equal(disabled('Calibrate accelerometer level'),true);assert.ok(container.textContent.includes('resolve board alignment'));
 render({cal_state:'accel_level',cal_manual:true,cal_samples:400,cal_required:1000});assert.ok(container.textContent.includes('400/1000'));assert.ok(button('Cancel level calibration'));assert.equal(container.findAll(e=>e.hasAttribute('data-storage-blocked'))[0].getAttribute('data-storage-blocked'),'true');
 render({accel_calibrated:true,calibration_storage:'unsaved',cal_state:'complete'});assert.ok(container.textContent.includes('correction applied in RAM. Use Save'));
 render({accel_calibrated:true,calibration_storage:'flash-verified'});assert.ok(container.textContent.includes('correction saved in flash'));
 render({cal_state:'error',cal_reason:'timeout',accel_calibrated:true,calibration_storage:'flash-verified'});assert.ok(container.textContent.includes('correction saved in flash'));
 const mounting:Partial<SensorSnapshot>={board_alignment_api:1,board_align_configured:[0,0,90],board_align_active:[0,0,90],board_align_reboot_required:false};
 render(mounting);assert(!disabled('Upside-down, keep yaw'));
 flushSync(()=>click('Upside-down, keep yaw'));await settle();assert.deepEqual(calls,[]);
 assert.equal(container.findAll(e=>e.hasAttribute('data-storage-blocked'))[0].getAttribute('data-storage-blocked'),'true');
 flushSync(()=>{click('Apply mounting settings');click('Apply mounting settings');});await settle();await settle();
 assert.deepEqual(calls,['set align_board_roll 180','set align_board_pitch 0','set align_board_yaw 90']);
 assert.ok(container.textContent.includes('Save to controller, then reboot'));
 render({...mounting,board_align_configured:[180,0,90],board_align_reboot_required:true});
 assert(disabled('Calibrate accelerometer level'));assert(!disabled('Upside-down, keep yaw'));
 assert.equal(container.findAll(e=>e.hasAttribute('data-storage-blocked'))[0].getAttribute('data-storage-blocked'),'false');
 setFailure('set align_board_pitch 0');flushSync(()=>click('Upside-down, keep yaw'));flushSync(()=>click('Apply mounting settings'));await settle();await settle();
 assert.deepEqual(calls,['set align_board_roll 180','set align_board_pitch 0']);assert.ok(container.textContent.includes('update incomplete'));
 assert.equal(container.findAll(e=>e.hasAttribute('data-storage-blocked'))[0].getAttribute('data-storage-blocked'),'true');
 setFailure();flushSync(()=>click('Discard local draft'));
 for(const overrides of [{arm:'armed' as const},{motor_active:true},{cal_manual:true,cal_state:'accel_wait'}]){render({...mounting,...overrides});assert(disabled('Upside-down, keep yaw'));}
 setConditions({fresh:false});render(mounting);assert(disabled('Upside-down, keep yaw'));
 setConditions({connected:false});render(mounting);assert(disabled('Upside-down, keep yaw'));
 setConditions();render();assert.equal(container.findAll(e=>e.tagName==='BUTTON'&&e.textContent==='Upside-down, keep yaw').length,0);
 console.log('PASS rendered mounting: preset keeps yaw without writes, serialized Apply, double-click guard, explicit Save/reboot, partial-failure lock, old/stale/armed/session guards');
 console.log('PASS rendered calibration page: exact level action, capability/orientation refusal, advanced collapse, cancel, Save lock, applied/saved retention');
} finally {flushSync(()=>root.unmount());}
