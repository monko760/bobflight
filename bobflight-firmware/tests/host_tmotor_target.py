#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Target source/codegen contract; not an MCU emulator or physical validation."""
import importlib.util,re,subprocess,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1]).resolve()
spec=importlib.util.spec_from_file_location('ir',root/'scripts/ir_codegen.py');ir=importlib.util.module_from_spec(spec);spec.loader.exec_module(ir)
p=root/'boards/tmotor-ir/tmotor_f7_v2.yaml';data=ir.parse_ir(p.read_text(),p.stem);header=ir.render(p,data)
for expected in ['"tmotor_f7_v2"','"STM32F722"','BOARD_GENERATED_HSE_MHZ      8u','BOARD_GENERATED_GYRO_SPI     1u','BOARD_GENERATED_GYRO_CS      HAL_PIN_PACK(0u, 4u)','BOARD_GENERATED_GYRO_EXTI    HAL_PIN_PACK(2u, 4u)','BOARD_GENERATED_RX_UART      2u','BOARD_GENERATED_LED0_PIN    HAL_PIN_PACK(2u, 14u)','BOARD_GENERATED_IR_VERIFIED  0']:
 assert expected in header,expected
# Pin facts are zero-based GPIO numbers. Human motor labels and AUX are one-based.
for number,pin in [(1,0),(2,1),(3,4),(4,5)]:assert re.search(rf'BOARD_GENERATED_MOTOR{number}_PIN\s+HAL_PIN_PACK\(1u, {pin}u\)',header)
cm=(root/'CMakeLists.txt').read_text();assert 'TMOTORF7V2 requires the STM32F722' in cm;assert 'BOBFLIGHT_TARGET_MCU_STM32F722=1' in cm;assert 'BOBFLIGHT_FLIGHT_ENABLE OR BOBFLIGHT_ACCEL_BENCH_RELAXED' in cm
spi=(root/'src/hal/stm32f7/hal_spi.c').read_text();assert 'gyro_spi_map(b,cfg->bus_index,&base,&enable)' in spi
motor=(root/'src/hal/stm32f7/hal_tim_dma.c').read_text();assert 'strcmp(b->board_id,"kakute_f7_hdv")' in motor
adc=(root/'src/hal/stm32f7/hal_adc.c').read_text();assert 'strcmp(board_get()->board_id,"kakute_f7_hdv")' in adc
flash=(root/'src/hal/stm32f7/hal_flash.c').read_text();assert 'BOBFLIGHT_CONFIG_FLASH_F745' in flash;assert '!strcmp(b->board_id,"kakute_f7_hdv")' in flash
assert 'if(BOBFLIGHT_BOARD STREQUAL "kakute_f7_hdv" AND BOBFLIGHT_TARGET_MCU STREQUAL "STM32F745")' in cm
clock=(root/'src/hal/stm32f7/hal_clock.c').read_text();assert '#if !defined(BOBFLIGHT_TARGET_TMOTORF7V2)\n    clock_pll_off();\n    clock_pwr_scale1_od(true);' in clock
startup=(root/'src/hal/stm32f7/startup_stm32f722.c').read_text();assert '#define EARLY_LED_GPIO_BASE 0x40020800u' in startup;assert '#define EARLY_LED_PIN 14u' in startup
assert '(volatile uint32_t *)0x40020014u' not in startup
board=(root/'src/board/ir_load.c').read_text();assert '0x452u' in board and '0x1FF07A22u==512u' in board
probe=(root/'src/drivers/gyro.c').read_text();assert 'if(id!=0x68u)return false;' in probe
link=(root/'cmake/stm32f722.ld').read_text();assert 'LENGTH = 512K' in link and 'LENGTH = 64K' in link and 'LENGTH = 192K' in link and '> DMA_RAM' in link
# Execute the actual board loader with the generated IR (host stubs, no MMIO).
with tempfile.TemporaryDirectory() as td:
 td=Path(td);(td/'board').mkdir();(td/'board/pins_generated.h').write_text(header)
 check=td/'check.c';check.write_text('''#include "board/board.h"
#include <assert.h>
#include <string.h>
int main(void){assert(board_init());const board_t*b=board_get();assert(!strcmp(b->board_id,"tmotor_f7_v2"));assert(!b->ir_verified);assert(b->gyro_spi_bus==1);assert(b->rx_pin==HAL_PIN_PACK(0,3));assert(b->rx_uart==2);assert(!board_select_rx_uart(4));assert(b->rx_uart==2);return 0;}
''')
 # This contract is also run on Windows: use CMake's selected C compiler when provided.
 compiler=sys.argv[2] if len(sys.argv)>2 else 'cc'
 exe=td/('check.exe' if sys.platform=='win32' else 'check')
 subprocess.run([compiler,'-std=c11','-DBOBFLIGHT_HOST=1','-I'+str(td),'-I'+str(root/'src'),'-I'+str(root/'include'),str(check),str(root/'src/board/ir_load.c'),'-o',str(exe)],check=True)
 subprocess.run([str(exe)],check=True)
print('PASS TMOTORF7V2 codegen + real host board loader, sensor-only guards, F722 memory/toolchain/clock/LED contract (not hardware validation)')

# CMake must actually refuse unsafe/mismatched configurations, not just document them.
with tempfile.TemporaryDirectory() as td:
 for i,flag in enumerate(['-DBOBFLIGHT_FLIGHT_ENABLE=ON','-DBOBFLIGHT_ACCEL_BENCH_RELAXED=ON','-DBOBFLIGHT_TARGET_MCU=STM32F745']):
  result=subprocess.run(['cmake','-S',str(root),'-B',str(Path(td)/str(i)),'-DBOBFLIGHT_BOARD=tmotor_f7_v2',flag],capture_output=True,text=True)
  assert result.returncode!=0 and 'TMOTORF7V2' in result.stdout+result.stderr,(flag,result.stdout,result.stderr)
print('PASS actual CMake refusal: flight ON, relaxed calibration ON, F745 toolchain mismatch')
