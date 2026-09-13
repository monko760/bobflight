/* SPDX-License-Identifier: Apache-2.0
 * Public peripheral/register facts: ST RM0385 (F745), RM0431 (F722).
 * Board wiring facts: owned YAML IR and its pinned source references.
 */
#ifndef BOBFLIGHT_GYRO_SPI_MAP_H
#define BOBFLIGHT_GYRO_SPI_MAP_H
#include "board/board.h"
#include <string.h>
static inline bool gyro_spi_map(const board_t *b,unsigned index,uintptr_t *base,uint32_t *enable){
 if(!b||!base||!enable||index!=b->gyro_spi_bus)return false;
 if(!strcmp(b->board_id,"kakute_f7_hdv")&&index==4u&&
    b->gyro_cs_pin==HAL_PIN_PACK(4,4)&&b->gyro_sck_pin==HAL_PIN_PACK(4,2)&&
    b->gyro_miso_pin==HAL_PIN_PACK(4,5)&&b->gyro_mosi_pin==HAL_PIN_PACK(4,6)){
  *base=0x40013400u;*enable=1u<<13;return true;
 }
 if(!strcmp(b->board_id,"tmotor_f7_v2")&&index==1u&&
    b->gyro_cs_pin==HAL_PIN_PACK(0,4)&&b->gyro_sck_pin==HAL_PIN_PACK(0,5)&&
    b->gyro_miso_pin==HAL_PIN_PACK(0,6)&&b->gyro_mosi_pin==HAL_PIN_PACK(0,7)){
  *base=0x40013000u;*enable=1u<<12;return true;
 }
 return false;
}
#endif
