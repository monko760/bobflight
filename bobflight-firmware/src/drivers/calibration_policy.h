/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_CALIBRATION_POLICY_H
#define BOBFLIGHT_CALIBRATION_POLICY_H
#ifndef BOBFLIGHT_ACCEL_BENCH_RELAXED
#define BOBFLIGHT_ACCEL_BENCH_RELAXED 0
#endif
#if BOBFLIGHT_ACCEL_BENCH_RELAXED != 0 && BOBFLIGHT_ACCEL_BENCH_RELAXED != 1
#error "BOBFLIGHT_ACCEL_BENCH_RELAXED must be 0 or 1"
#endif
#if BOBFLIGHT_ACCEL_BENCH_RELAXED && defined(BOBFLIGHT_MCU)
#error "Relaxed accelerometer checks are host-test-only: MCU images never relax sensor qualification"
#endif
#if BOBFLIGHT_ACCEL_BENCH_RELAXED
#define SC_PAIR_CENTER_MAX_G 0.10f
#define SC_POSE_RESIDUAL_MAX_G 0.15f
#else
#define SC_PAIR_CENTER_MAX_G 0.05f
#define SC_POSE_RESIDUAL_MAX_G 0.10f
#endif
#endif
