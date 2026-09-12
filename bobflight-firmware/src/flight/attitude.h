#ifndef BF_ATTITUDE_H
#define BF_ATTITUDE_H
#include <stdbool.h>
void attitude_init(void);
bool attitude_update(const float gyro[3],const float acc[3],float dt);
const float *attitude_degrees(void);
bool attitude_ready(void);
void attitude_setpoint(const float sticks[4],float out[3]);
#endif
