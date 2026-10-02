/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RPM notch filter (config schema 9): per-motor notches that track the motor
 * rotation frequency measured by bidirectional DShot eRPM telemetry.
 *
 *   fundamental_hz = eRPM / (motor_poles / 2) / 60     (FW only; mechanical Hz)
 *   notch h (1..harmonics) of motor m sits at h * max(min_hz, fundamental_hz)
 *   Q = rpm_filter_q_x100 / 100, the same for every notch.
 *
 * Pure logic, no drivers: the caller passes the eRPM input and the filter dt,
 * so the host unit test (tests/host_rpm_filter.c) covers everything here.
 * Coefficients: RBJ "Audio EQ Cookbook" notch (see flight/filter.h), with one
 * sin/cos per motor; harmonics use the Chebyshev recurrence
 *   cos(2w) = 2c^2 - 1, cos(3w) = 2c*cos(2w) - c, sin(2w) = 2sc, sin(3w) = s*cos(2w) + c*sin(2w).
 * Clean-room; no Betaflight source.
 */
#ifndef BOBFLIGHT_RPM_FILTER_H
#define BOBFLIGHT_RPM_FILTER_H
#include <stdbool.h>
#include <stdint.h>
#include "flight/filter.h"
#ifdef __cplusplus
extern "C" {
#endif

#define RPM_FILTER_MOTORS 4u
#define RPM_FILTER_MAX_HARMONICS 3u
/* Static setting domain (config.c validates, the CLI names it in replies). */
#define RPM_FILTER_MIN_HZ_LO 50.f
#define RPM_FILTER_MIN_HZ_HI 200.f
#define RPM_FILTER_Q_X100_LO 100.f
#define RPM_FILTER_Q_X100_HI 1000.f
#define RPM_FILTER_POLES_LO 4.f
#define RPM_FILTER_POLES_HI 36.f
#define RPM_FILTER_DEFAULT_HARMONICS 0.f
#define RPM_FILTER_DEFAULT_MIN_HZ 100.f
#define RPM_FILTER_DEFAULT_Q_X100 500.f
#define RPM_FILTER_DEFAULT_POLES 14.f
/* Design ceiling for the motor fundamental (24 000 mechanical RPM). A harmonic
 * h is used only if h * RPM_FILTER_TOP_FUND_HZ < 0.45 * fs, which gives
 * 1 harmonic at 1 kHz and 3 at 4 kHz / 8 kHz (reported as harmonics_active). */
#define RPM_FILTER_TOP_FUND_HZ 400.f
/* Each notch fades in/out over this time (y = x + w*(notch(x) - x)). */
#define RPM_FILTER_FADE_S 0.002f

/* `rpm_filter_reason`, highest precedence first. */
typedef enum {
    RPM_FILTER_OFF = 0,           /* rpm_filter_harmonics 0 */
    RPM_FILTER_BIDIR_OFF,         /* dshot_bidir off (never auto-enabled) */
    RPM_FILTER_ERPM_UNAVAILABLE,  /* bidir on, but no motor has valid eRPM */
    RPM_FILTER_OK                 /* at least one motor tracked */
} rpm_filter_reason_t;
const char *rpm_filter_reason_name(rpm_filter_reason_t r);

typedef struct {
    unsigned harmonics;   /* 0..3 */
    float min_hz;         /* 50..200 */
    float q;              /* rpm_filter_q_x100 / 100 */
    unsigned poles;       /* even 4..36 */
} rpm_filter_settings_t;

/* One snapshot of the telemetry. valid[m]: bidir on, telem OK and eRPM > 0. */
typedef struct {
    bool bidir;
    bool valid[RPM_FILTER_MOTORS];
    uint32_t erpm[RPM_FILTER_MOTORS];
} rpm_filter_input_t;

typedef struct {
    rpm_filter_settings_t set;
    float dt;
    bool configured;
    rpm_filter_reason_t reason;
    unsigned harmonics_active;
    bool motor_valid[RPM_FILTER_MOTORS];
    float fund_hz[RPM_FILTER_MOTORS];     /* held fundamental (>= min_hz) of the coefficients */
    bool want[RPM_FILTER_MOTORS][RPM_FILTER_MAX_HARMONICS];
    bool prime[RPM_FILTER_MOTORS][RPM_FILTER_MAX_HARMONICS];
    float weight[RPM_FILTER_MOTORS][RPM_FILTER_MAX_HARMONICS]; /* 0 bypass .. 1 full */
    filter_biquad_t coeff[RPM_FILTER_MOTORS][RPM_FILTER_MAX_HARMONICS];
    filter_biquad_state_t state[RPM_FILTER_MOTORS][RPM_FILTER_MAX_HARMONICS][3];
    unsigned rr;          /* round-robin motor for the next coefficient update */
    uint32_t coeff_updates; /* motors recomputed (diagnostics/tests) */
} rpm_filter_bank_t;

/** Mechanical rotation frequency in Hz; 0 when eRPM or poles are unusable. */
float rpm_filter_fundamental_hz(uint32_t erpm, unsigned poles);
/** Harmonics the static ceiling allows at sample rate fs (0..3). */
unsigned rpm_filter_allowed_harmonics(float sample_hz);
/** Reason from the settings and one telemetry snapshot (precedence above). */
rpm_filter_reason_t rpm_filter_evaluate(unsigned harmonics, const rpm_filter_input_t *in);
/** RBJ notch from cos/sin of w0 = 2*pi*f0/fs and Q; false leaves *c passthrough. */
bool rpm_filter_notch_coeff(filter_biquad_t *c, float cos_w0, float sin_w0, float q);

void rpm_filter_init(rpm_filter_bank_t *b);
/**
 * Once per filter sample (and from the CLI report): reason, per-motor validity,
 * held frequencies, which notches should run, and coefficients for one motor
 * (round-robin). All motors are recomputed when dt or a setting changed, and a
 * motor whose notch starts is recomputed at once. A notch that fades out keeps
 * its last coefficients. A notch at or above 0.45 * fs is bypassed.
 */
void rpm_filter_update(rpm_filter_bank_t *b, const rpm_filter_settings_t *s, const rpm_filter_input_t *in, float dt);
/** Apply every running notch to the three axes in place and advance the fades. */
void rpm_filter_apply(rpm_filter_bank_t *b, float v[3]);
/** Number of notches currently running (weight > 0). */
unsigned rpm_filter_running(const rpm_filter_bank_t *b);

#ifdef __cplusplus
}
#endif
#endif /* BOBFLIGHT_RPM_FILTER_H */
