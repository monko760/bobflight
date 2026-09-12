/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */

export interface SensorSnapshot {
  sensors_version: number;
  sample_seq: number;
  sample_ms: number;
  sensor_age_ms: number;
  gyro_ok: boolean;
  gyro_calibrated: boolean;
  accel_calibrated: boolean;
  gyro_dps: [number, number, number];
  accel_g: [number, number, number];
  accel_raw_g: [number, number, number];
  attitude_deg: [number, number, number];
  arm: "armed" | "disarmed";
  motor_active: boolean;
  attitude_ready?: boolean;
  cal_manual?: boolean;
  cal_state: "idle" | "gyro" | "accel_wait" | "accel_collect" | "complete" | "error" | string;
  cal_samples: number;
  cal_required: number;
  cal_faces: number; // bitmask 0..63 (+x, -x, +y, -y, +z, -z)
  cal_face: number; // -1..5
  cal_reason: string;
  calibration_storage: string;
  // Extended fields from 'calibration' command
  gyro_bias?: [number, number, number];
  accel_bias?: [number, number, number];
  accel_scale?: [number, number, number];
  sensor_config_ok?: boolean;
  mpu_gyro_config?: string;
  mpu_accel_config?: string;
  sensor_chip?: string;
  cal_apply_detail?: string;
  cal_diagnostics_version?: number;
  cal_raw_faces?: Array<[number,number,number] | null>;
  cal_candidate_valid?: boolean;
  cal_candidate_bias?: [number,number,number];
  cal_candidate_scale?: [number,number,number];
  rawText?: string;
}

export interface AxisFaceDef {
  index: number; // 0..5
  key: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  label: string;
  shortLabel: string;
  description: string;
  bit: number; // 1 << index
}

export const AXIS_FACES: readonly AxisFaceDef[] = (["+x","-x","+y","-y","+z","-z"] as const).map((key,index)=>({
  key,index,bit:1<<index,label:`${key.toUpperCase()} face`,shortLabel:key.toUpperCase(),
  description:`Rotate until raw ${key.slice(1).toUpperCase()} has a dominant ${key[0]} reading. Keep the selected axis vertical; raw offsets may prevent exactly 1 g or zero on the other axes. Do not assume the board's nose or mounting direction.`,
}));

export function isFaceCaptured(calFacesBitmask: number, faceIndex: number): boolean {
  return (calFacesBitmask & (1 << faceIndex)) !== 0;
}

export function areAllFacesCaptured(calFacesBitmask: number): boolean {
  return (calFacesBitmask & 0x3f) === 0x3f;
}

export function countCapturedFaces(calFacesBitmask: number): number {
  let count = 0;
  for (let i = 0; i < 6; i++) {
    if ((calFacesBitmask & (1 << i)) !== 0) count++;
  }
  return count;
}

export function parseThreeFloats(str: string | undefined): [number,number,number] {
  const tokens=str?.trim().split(/\s+/)??[];
  if(tokens.length!==3 || tokens.some(v=>!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v)))return [NaN,NaN,NaN];
  const v=tokens.map(Number);return v.every(Number.isFinite)?v as [number,number,number]:[NaN,NaN,NaN];
}
export function parseKeyValueSnapshot(rawText:string):SensorSnapshot|null {
  const kv:Record<string,string>={};
  for(const line of rawText.split(/\r?\n/)) {
    const i=line.indexOf(":");if(i<1)continue;
    const k=line.slice(0,i).trim(),v=line.slice(i+1).trim();
    if(Object.prototype.hasOwnProperty.call(kv,k))return null;
    kv[k]=v;
  }
  if(kv.sensors_version!=="1" || !((kv.sensors_end==="1") !== (kv.calibration_end==="1")))return null;
  const uint=(k:string,max=0xffffffff)=> /^\d+$/.test(kv[k]??"") && Number(kv[k])<=max?Number(kv[k]):NaN;
  const boolKeys=["gyro_ok","gyro_calibrated","accel_calibrated","motor_active","sensor_config_ok","attitude_ready","cal_manual"];
  if(boolKeys.some(k=>kv[k]!=="yes" && kv[k]!=="no"))return null;
  if(kv.arm!=="armed" && kv.arm!=="disarmed")return null;
  if(!["idle","gyro","accel_wait","accel_collect","complete","error"].includes(kv.cal_state))return null;
  if(kv.calibration_storage!=="ram-only" || kv.cal_reason===undefined)return null;
  const nums={sample_seq:uint("sample_seq"),sample_ms:uint("sample_ms"),sensor_age_ms:uint("sensor_age_ms"),cal_samples:uint("cal_samples",30000),cal_required:uint("cal_required",1000),cal_faces:uint("cal_faces",63)};
  if(Object.values(nums).some(n=>!Number.isFinite(n)) || !/^(?:-1|[0-5])$/.test(kv.cal_face??""))return null;
  const vectors={gyro_dps:parseThreeFloats(kv.gyro_dps),accel_g:parseThreeFloats(kv.accel_g),accel_raw_g:parseThreeFloats(kv.accel_raw_g),attitude_deg:parseThreeFloats(kv.attitude_deg)};
  if(Object.values(vectors).some(v=>v.some(n=>!Number.isFinite(n)||Math.abs(n)>10000)))return null;
  const snapshot:SensorSnapshot={sensors_version:1,...nums,...vectors,arm:kv.arm,
    gyro_ok:kv.gyro_ok==="yes",gyro_calibrated:kv.gyro_calibrated==="yes",accel_calibrated:kv.accel_calibrated==="yes",
    motor_active:kv.motor_active==="yes",sensor_config_ok:kv.sensor_config_ok==="yes",attitude_ready:kv.attitude_ready==="yes",cal_manual:kv.cal_manual==="yes",
    cal_state:kv.cal_state,cal_face:Number(kv.cal_face),cal_reason:kv.cal_reason,calibration_storage:kv.calibration_storage,rawText};
  for(const key of ["gyro_bias","accel_bias","accel_scale"] as const)if(kv[key]!==undefined){
    const v=parseThreeFloats(kv[key]);if(v.some(n=>!Number.isFinite(n)))return null;snapshot[key]=v;
  }
  if(kv.cal_apply_detail!==undefined){if(kv.cal_apply_detail.length>255)return null;snapshot.cal_apply_detail=kv.cal_apply_detail;}
  if(kv.cal_diagnostics_version!==undefined) {
    if(kv.cal_diagnostics_version!=="1" || kv.calibration_end!=="1" || !["yes","no"].includes(kv.cal_candidate_valid))return null;
    snapshot.cal_diagnostics_version=1;snapshot.cal_raw_faces=[];
    for(let i=0;i<6;i++) {
      const value=kv[`cal_raw_face_${i}`],captured=isFaceCaptured(snapshot.cal_faces,i);
      if(!captured){if(value!=="uncaptured")return null;snapshot.cal_raw_faces.push(null);continue;}
      if(value==="unavailable"){snapshot.cal_raw_faces.push(null);continue;}
      const v=parseThreeFloats(value);if(v.some(n=>!Number.isFinite(n)||Math.abs(n)>10000))return null;
      snapshot.cal_raw_faces.push(v);
    }
    snapshot.cal_candidate_valid=kv.cal_candidate_valid==="yes";
    for(const key of ["cal_candidate_bias","cal_candidate_scale"] as const) {
      if(snapshot.cal_candidate_valid) {
        const v=parseThreeFloats(kv[key]);if(v.some(n=>!Number.isFinite(n)||Math.abs(n)>10000))return null;snapshot[key]=v;
      } else if(kv[key]!==undefined)return null;
    }
  }
  snapshot.mpu_gyro_config=kv.mpu_gyro_config;snapshot.mpu_accel_config=kv.mpu_accel_config;snapshot.sensor_chip=kv.sensor_chip;
  return snapshot;
}
export function isSnapshotFresh(snapshot:SensorSnapshot|null,prevSeq:number|null,receiptHostTimeMs:number,nowHostTimeMs:number,maxAgeMs=250):boolean {
  if(!snapshot || snapshot.sample_seq===0 || !Number.isFinite(snapshot.sensor_age_ms))return false;
  const age=nowHostTimeMs-receiptHostTimeMs;
  return age>=0 && snapshot.sensor_age_ms+age<=maxAgeMs && (prevSeq===null || snapshot.sample_seq!==prevSeq);
}

export function computeFps(receiptTimestampsMs: number[], windowMs = 1000, nowMs = Date.now()): number {
  const recent = receiptTimestampsMs.filter((t) => nowMs - t <= windowMs);
  return recent.length;
}

export interface ActionGateContext {
  connected: boolean;
  snapshot: SensorSnapshot | null;
  fresh: boolean;
  propsOff: boolean;
  stationary: boolean;
  pending?: boolean;
}

export interface ActionGateResult {
  allowed: boolean;
  reasons: string[];
}

export function checkActionGates(
  action: "gyro_cal" | "accel_start" | "accel_face" | "accel_apply" | "accel_cancel",
  ctx: ActionGateContext
): ActionGateResult {
  const reasons: string[] = [];

  if (!ctx.connected) {
    reasons.push("Board is not connected");
    return { allowed: false, reasons };
  }

  if (action === "accel_cancel") {
    if (ctx.pending) reasons.push("Command in progress");
    return { allowed: reasons.length === 0, reasons };
  }

  if (ctx.pending) reasons.push("Command in progress");
  if (!ctx.snapshot) reasons.push("No telemetry data received");
  if (!ctx.fresh) reasons.push("Telemetry data is stale or unavailable");

  if (ctx.snapshot) {
    if (ctx.snapshot.arm !== "disarmed") reasons.push("Quadcopter is armed");
    if (ctx.snapshot.motor_active) reasons.push("Motors are active");
    if (!ctx.snapshot.gyro_ok) reasons.push("Gyro sensor health check failed");

    if(ctx.snapshot.sensor_config_ok!==true)reasons.push("Sensor configuration is not verified");
    if(action==="gyro_cal" || action==="accel_start") {
      if(ctx.snapshot.cal_manual || ["accel_wait","accel_collect"].includes(ctx.snapshot.cal_state))reasons.push("Cancel or finish the active calibration session first");
      else if(action==="gyro_cal" && ctx.snapshot.cal_state==="gyro")reasons.push("Gyro calibration is already running; use Cancel gyro calibration to stop it");
    } else if(!ctx.snapshot.cal_manual || ctx.snapshot.cal_state!=="accel_wait")reasons.push("Start a six-face session and wait for the current capture");

    if (action === "accel_apply") {
      if (!areAllFacesCaptured(ctx.snapshot.cal_faces)) {
        reasons.push(`All 6 faces must be captured first (${countCapturedFaces(ctx.snapshot.cal_faces)}/6 collected)`);
      }
    }
  }

  if (!ctx.propsOff) reasons.push("Props-off safety checkbox not confirmed");
  if (!ctx.stationary) reasons.push("Stationary bench checkbox not confirmed");

  return { allowed: reasons.length === 0, reasons };
}

export function formatFloat(val: number | undefined, digits = 2): string {
  if (val === undefined || !Number.isFinite(val)) return "—";
  return val.toFixed(digits);
}

export function formatVector(vec: [number, number, number] | undefined, digits = 2): string {
  if (!vec) return "—";
  return vec.map((v) => formatFloat(v, digits)).join(", ");
}
