import assert from 'node:assert/strict';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {installFakeDom} from './fixtures/fakeDom';
import {SensorsPage} from '../src/pages/SensorsPage';
import {setSnapshot,calls} from './fixtures/calibrationUiStub';
import type {SensorSnapshot} from '../src/sensors/telemetry';
const {container}=installFakeDom();const root=createRoot(container as never);
const base:SensorSnapshot={sensors_version:1,sample_seq:1,sample_ms:1,sensor_age_ms:0,gyro_ok:true,gyro_calibrated:true,accel_calibrated:false,gyro_dps:[0,0,0],accel_g:[0,0,.87],accel_raw_g:[0,0,.87],attitude_deg:[0,0,0],attitude_ready:true,arm:'disarmed',motor_active:false,cal_state:'idle',cal_manual:false,cal_samples:0,cal_required:0,cal_faces:0,cal_face:-1,cal_reason:'idle',calibration_storage:'not-calibrated',sensor_config_ok:true,calibration_api:2,cal_accel_level_supported:true,gyro_bias_applied:true};
function render(overrides:Partial<SensorSnapshot>={}){setSnapshot({...base,...overrides});flushSync(()=>root.render(<SensorsPage/>));}
function button(label:string){const el=container.findAll(e=>e.tagName==='BUTTON'&&e.textContent===label)[0];assert.ok(el,label);return el;}
function disabled(label:string){const el=button(label);return el.disabled||el.hasAttribute('disabled');}
try {
 render();assert.equal(disabled('Calibrate accelerometer level'),false);
 const b=button('Calibrate accelerometer level');const key=Object.keys(b).find(k=>k.startsWith('__reactProps$'));assert.ok(key);(b as any)[key].onClick();assert.deepEqual(calls,['calibrate_accel level']);
 assert.equal(container.findAll(e=>e.tagName==='DETAILS')[0].hasAttribute('open'),false);
 render({calibration_api:undefined,cal_accel_level_supported:undefined});assert.equal(disabled('Calibrate accelerometer level'),true);assert.ok(container.textContent.includes('does not advertise level calibration'));
 render({accel_raw_g:[0,0,-.876]});assert.equal(disabled('Calibrate accelerometer level'),true);assert.ok(container.textContent.includes('resolve board alignment'));
 render({cal_state:'accel_level',cal_manual:true,cal_samples:400,cal_required:1000});assert.ok(container.textContent.includes('400/1000'));assert.ok(button('Cancel level calibration'));assert.equal(container.findAll(e=>e.hasAttribute('data-storage-blocked'))[0].getAttribute('data-storage-blocked'),'true');
 render({accel_calibrated:true,calibration_storage:'unsaved',cal_state:'complete'});assert.ok(container.textContent.includes('correction applied in RAM. Use Save'));
 render({accel_calibrated:true,calibration_storage:'flash-verified'});assert.ok(container.textContent.includes('correction saved in flash'));
 render({cal_state:'error',cal_reason:'timeout',accel_calibrated:true,calibration_storage:'flash-verified'});assert.ok(container.textContent.includes('correction saved in flash'));
 console.log('PASS rendered calibration page: exact level action, capability/orientation refusal, advanced collapse, cancel, Save lock, applied/saved retention');
} finally {flushSync(()=>root.unmount());}
