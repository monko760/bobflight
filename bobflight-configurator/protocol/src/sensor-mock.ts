/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** The offline mock has no IMU. Never invent fresh samples or successful calibration. */
export function mockSensorReply(command: string, armed = false): string | null {
  if (command === "sensors" || command === "calibration") {
    return [
      "sensors_version: 1", "sample_seq: 0", "sample_ms: 0", "sensor_age_ms: 4294967295",
      "gyro_ok: no", "gyro_calibrated: no", "accel_calibrated: no",
      "gyro_dps: 0 0 0", "accel_g: 0 0 0", "accel_raw_g: 0 0 0", "attitude_deg: 0 0 0",
      `arm: ${armed ? "armed" : "disarmed"}`, "motor_active: no", "attitude_ready: no", "cal_manual: no", "cal_state: idle",
      "cal_samples: 0", "cal_required: 0", "cal_faces: 0", "cal_face: -1",
      "cal_reason: mock IMU unavailable", "calibration_storage: ram-only", "sensor_config_ok: no",
      ...(command === "calibration" ? ["sensor_chip: mock-unavailable", "gyro_bias: 0 0 0", "accel_bias: 0 0 0", "accel_scale: 1 1 1", "mpu_gyro_config: unavailable", "mpu_accel_config: unavailable"] : []),
      `${command}_end: 1`, "",
    ].join("\r\n");
  }
  if (command === "calibration_cancel" || command === "calibrate_accel cancel") return "no calibration active (mock)\r\n";
  if (command === "calibrate_gyro" || command.startsWith("calibrate_accel ")) return "calibration refused: mock IMU unavailable\r\n";
  return null;
}
