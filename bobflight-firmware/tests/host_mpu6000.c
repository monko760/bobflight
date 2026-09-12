#include "drivers/gyro.h"
#include "board/board.h"
#include "hal/hal.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
static board_t b;static unsigned char regs[128];static bool broken,healthy;
const board_t *board_get(void){return &b;}
bool board_pins_live(void){return true;}bool board_mmio_permitted(void){return false;}
void arming_set_gyro_healthy(bool h){healthy=h;}
hal_spi_bus_t *hal_spi_open(unsigned n){return n==4?(hal_spi_bus_t*)&b:0;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;if(broken)return false;memset(rx,0,n);
 if(tx[0]&128){for(size_t i=1;i<n;i++)rx[i]=regs[(tx[0]&127)+i-1];}
 else if(n==2)regs[tx[0]]=tx[1];return true;
}
static void val(unsigned a,int v){regs[a]=(unsigned)v>>8;regs[a+1]=v;}
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d\n",__LINE__);return 1;}} while(0)
int main(void){float d[3];b.gyro_spi_bus=4;b.gyro_cs_pin=HAL_PIN_PACK(4,4);
 strcpy(b.gyro_chip,"MPU6000");strcpy(b.gyro_align,"CW270_DEG");regs[0x75]=0x68;
 gyro_init();CHECK(healthy&&gyro_is_healthy());CHECK(regs[0x1B]==0x18&&regs[0x1C]==0x10&&regs[0x1A]==3);
 val(0x3B,2048);val(0x3D,1024);val(0x3F,4096);val(0x43,164);val(0x45,-328);val(0x47,492);
 CHECK(gyro_sample(d));CHECK(fabsf(d[0]-20)<.01f&&fabsf(d[1]-10)<.01f&&fabsf(d[2]-30)<.01f);
 CHECK(fabsf(gyro_accel_g()[0]+.25f)<.001f&&fabsf(gyro_accel_g()[1]-.5f)<.001f);
 val(0x3B,0);val(0x3D,0);val(0x43,16);val(0x45,0);val(0x47,0);gyro_begin_calibration();
 for(int i=0;i<999;i++)CHECK(gyro_sample(d));CHECK(!gyro_calibrated());
 val(0x43,1640);CHECK(gyro_sample(d));val(0x43,16);
 for(int i=0;i<999;i++)CHECK(gyro_sample(d));CHECK(!gyro_calibrated());
 CHECK(gyro_sample(d));CHECK(gyro_calibrated());CHECK(fabsf(d[1])<.001f);
 broken=true;CHECK(!gyro_sample(d));CHECK(!healthy&&!gyro_is_healthy());
 puts("PASS: MPU6000 setup, scaling, alignment, calibration reset and bus failure");return 0;
}
