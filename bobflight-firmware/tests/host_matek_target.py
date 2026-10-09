#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Matek IR, real board loader and route refusal contract. Not hardware qualification."""
import importlib.util,subprocess,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1]).resolve()
spec=importlib.util.spec_from_file_location('ir',root/'scripts/ir_codegen.py');ir=importlib.util.module_from_spec(spec);spec.loader.exec_module(ir)
p=root/'boards/matek-ir/matek_f722_px.yaml';d=ir.parse_ir(p.read_text(),p.stem);header=ir.render(p,d)
for expected in ['"matek_f722_px"','"STM32F722"','"CW180_DEG_FLIP"','BOARD_GENERATED_HSE_MHZ      8u','BOARD_GENERATED_GYRO_CS      HAL_PIN_PACK(1u, 2u)','BOARD_GENERATED_GYRO_EXTI    HAL_PIN_PACK(2u, 4u)','BOARD_GENERATED_RX_UART      2u','BOARD_GENERATED_LED0_PIN    HAL_PIN_PACK(0u, 14u)','BOARD_GENERATED_IR_VERIFIED  0']:
 assert expected in header,expected
with tempfile.TemporaryDirectory() as td:
 t=Path(td);(t/'board').mkdir();(t/'board/pins_generated.h').write_text(header)
 c=t/'check.c';c.write_text('''#include "board/board.h"
#include <assert.h>
#include <string.h>
int main(void){
 assert(board_init());const board_t*b=board_get();assert(!strcmp(b->board_id,"matek_f722_px"));
 assert(!b->ir_verified&&b->ir_bf_derived);assert(b->hse_mhz==8);assert(!strcmp(b->gyro_align,"CW180_DEG_FLIP"));
 assert(b->gyro_spi_bus==1&&b->gyro_cs_pin==HAL_PIN_PACK(1,2));assert(b->gyro_exti_pin==HAL_PIN_PACK(2,4));
 assert(b->rx_uart==2&&b->rx_pin==HAL_PIN_PACK(0,3)&&b->tx_pin==HAL_PIN_PACK(0,2));
 const hal_pin_t tx[]={HAL_PIN_PACK(0,9),HAL_PIN_PACK(0,2),HAL_PIN_PACK(2,10),HAL_PIN_PACK(0,0)};
 const hal_pin_t rx[]={HAL_PIN_PACK(0,10),HAL_PIN_PACK(0,3),HAL_PIN_PACK(2,11),HAL_PIN_PACK(0,1)};
 for(unsigned i=1;i<=4;i++){assert(board_select_rx_uart(i));assert(b->rx_uart==i&&b->rx_pin==rx[i-1]&&b->tx_pin==tx[i-1]);}
 for(unsigned i=0;i<256;i++)if(i<1||i>4){assert(!board_select_rx_uart(i));assert(b->rx_uart==4&&b->rx_pin==rx[3]&&b->tx_pin==tx[3]);}
 assert(board_select_rx_uart(2));return 0;}
''')
 compiler=sys.argv[2] if len(sys.argv)>2 else 'cc';exe=t/('check.exe' if sys.platform=='win32' else 'check')
 subprocess.run([compiler,'-std=c11','-DBOBFLIGHT_HOST=1','-I'+str(t),'-I'+str(root/'src'),'-I'+str(root/'include'),str(c),str(root/'src/board/ir_load.c'),'-o',str(exe)],check=True)
 subprocess.run([str(exe)],check=True)
 for i,flag in enumerate(['-DBOBFLIGHT_FLIGHT_ENABLE=ON','-DBOBFLIGHT_ACCEL_BENCH_RELAXED=ON','-DBOBFLIGHT_TARGET_MCU=STM32F745']):
  result=subprocess.run(['cmake','-S',str(root),'-B',str(t/str(i)),'-DBOBFLIGHT_BOARD=matek_f722_px',flag],capture_output=True,text=True)
  assert result.returncode!=0,(flag,result.stdout,result.stderr)
print('PASS Matek actual generated board loader: exact SPI/orientation/LED/default RX; UART1-4 only; UART5/6/7 refused without mutation; unsafe build flags refused')
