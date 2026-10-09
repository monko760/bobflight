/* SPDX-License-Identifier: Apache-2.0. Background-only sensor acquisition. */
#include "drivers/barometer.h"
#include "hal/i2c_reg.h"
#include "board/board.h"
static bmp280_t sensor;
static bool attempted,bound;
static bool begin(uint8_t a,uint8_t r,void *data,size_t n,bool read,uint32_t now){
 (void)now;return n<=255u&&i2c_reg_begin(a,r,data,(uint8_t)n,read,hal_micros());
}
static int poll(uint32_t now){(void)now;return i2c_reg_poll(hal_micros());}
void barometer_poll(void){
 if(!attempted){
  attempted=true;const board_t *b=board_get();
  bound=b&&i2c_reg_bind(b->baro_i2c_bus,b->baro_scl_pin,b->baro_sda_pin);
  if(bound){const bmp280_io_t io={begin,poll,i2c_reg_cancel,NULL};bmp280_init(&sensor,&io,hal_millis());}
  return;
 }
 if(bound)bmp280_poll(&sensor,hal_millis());
}
bool barometer_read_snapshot(bmp280_snapshot_t *out){
 if(!out)return false;
 if(!bound){memset(out,0,sizeof *out);out->reason=attempted?"unsupported-bus":"not-started";out->age_ms=UINT32_MAX;return false;}
 return bmp280_snapshot(&sensor,hal_millis(),out);
}
