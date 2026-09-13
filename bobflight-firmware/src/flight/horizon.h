/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_HORIZON_H
#define BOBFLIGHT_HORIZON_H
/* Bench-only blend, no altitude/heading hold or flight qualification. */
float horizon_rate_weight(const float sticks[4]);
void horizon_setpoint(const float sticks[4],float out[3]);
#endif
