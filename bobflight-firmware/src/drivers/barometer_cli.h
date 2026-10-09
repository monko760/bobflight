/* SPDX-License-Identifier: Apache-2.0. Read-only diagnostic. */
#ifndef BF_BAROMETER_CLI_H
#define BF_BAROMETER_CLI_H
#include "drivers/barometer.h"
static bool cmd_barometer(const char *line){
 if(strcmp(line,"barometer"))return false;
 bmp280_snapshot_t s;barometer_read_snapshot(&s);char out[640];
 snprintf(out,sizeof out,"barometer_api: 1\r\nbarometer_reason: %s\r\nbarometer_address: %02X\r\nbarometer_sample: %lu\r\nbarometer_age_ms: %lu\r\nbarometer_valid: %s\r\nbarometer_pressure_pa: %.2f\r\nbarometer_temperature_c: %.2f\r\nbarometer_reference_pa: %.2f\r\nbarometer_altitude_cm: %.1f\r\nbarometer_altitude_valid: %s\r\nbarometer_datum: startup-32-sample-mean\r\nbarometer_end: 1\r\n",s.reason?s.reason:"unknown",s.address,(unsigned long)s.sample_seq,(unsigned long)s.age_ms,s.valid?"yes":"no",(double)s.pressure,(double)s.temp,(double)s.reference,(double)s.relativealt,s.alt_valid?"yes":"no");
 cli_write_str(out);return true;
}
#endif
