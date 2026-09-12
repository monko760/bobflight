/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BENCH_PARSE_H
#define BOBFLIGHT_BENCH_PARSE_H
#include <stdbool.h>
/* Canonical ASCII decimal only. No scanf overflow, signs, fractions, leading
 * zeroes or extra arguments. Matches the configurator's command allowlist. */
static inline bool bench_parse_motor(const char *s, unsigned *motor) {
    if(!s || !motor || s[0]<'0' || s[0]>'4' || s[1]!='\0')return false;
    *motor=(unsigned)(s[0]-'0');return true;
}
static inline bool bench_parse_pulse(const char *s, unsigned *motor, unsigned *percent) {
    if(!s || !motor || !percent || s[0]<'1' || s[0]>'4' || s[1]!=' ')return false;
    const char *p=s+2;
    if(p[0]<'0' || p[0]>'9')return false;
    unsigned value=(unsigned)(p[0]-'0');
    if(p[1]!='\0') {
        if(p[0]=='0' || p[1]<'0' || p[1]>'9' || p[2]!='\0')return false;
        value=value*10u+(unsigned)(p[1]-'0');
    }
    if(value>35u)return false;
    *motor=(unsigned)(s[0]-'0');*percent=value;return true;
}
#endif
