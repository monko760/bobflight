#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Execute actual F722 flash backend against a bounded ARM register model.
Not silicon, power-loss timing, watchdog timing or physical USB qualification.
Sector facts: RM0431 and STMicroelectronics/STM32CubeF7 issue 56 (fixed v1.16.2).
"""
import struct,subprocess,tempfile,unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_LR,UC_ARM_REG_PC,UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_PRIMASK,UC_CPU_ARM_CORTEX_M4
ROOT=Path(__file__).resolve().parents[1]
KEY,SR,CR=0x40023c04,0x40023c0c,0x40023c10
BASE,SLOT=0x08004000,16384
class Machine:
 def __init__(self,elf):
  self.u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);self.u.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
  for a,n in [(0x08000000,0x80000),(0x20000000,0x40000),(0x40000000,0x30000),(0x1ff07000,0x1000),(0xe000e000,0x2000),(0xe0042000,0x1000)]:self.u.mem_map(a,n)
  self.u.mem_write(0x08000000,b'\xff'*0x80000)
  with open(elf,'rb') as f:
   e=ELFFile(f);self.sym={s.name:s['st_value'] for s in e.get_section_by_name('.symtab').iter_symbols()}
   for p in e.iter_segments():
    if p['p_type']=='PT_LOAD' and p['p_filesz']:self.u.mem_write(p['p_vaddr'],p.data())
  self.put(0xe0042000,0x452);self.u.mem_write(0x1ff07a22,struct.pack('<H',512))
  self.reg={CR:1<<31,SR:0};self.keys=[];self.sectors=[];self.program=[];self.fail_unlock=False;self.fail_erase=False;self.fail_program=False
  self.put(0x40003004,3);self.put(0x40003008,511)
  self.u.hook_add(UC_HOOK_MEM_READ,self.read,begin=0x40023000,end=0x40023fff)
  self.u.hook_add(UC_HOOK_MEM_WRITE,self.write)
 def put(self,a,v):self.u.mem_write(a,struct.pack('<I',v))
 def get(self,a):return struct.unpack('<I',self.u.mem_read(a,4))[0]
 def read(self,u,access,a,n,v,_):
  if a in self.reg:self.put(a,self.reg[a])
 def write(self,u,access,a,n,v,_):
  if a==KEY:
   self.keys.append(v)
   if self.keys[-2:]==[0x45670123,0xcdef89ab] and not self.fail_unlock:self.reg[CR]&=~(1<<31)
  elif a==SR:self.reg[SR]&=~v
  elif a==CR:
   self.reg[CR]=v
   if v&(1<<16):
    sector=(v>>3)&15;assert sector in (1,2);assert v&2 and not v&4
    assert u.reg_read(UC_ARM_REG_PRIMASK)&1
    self.sectors.append(sector)
    if self.fail_erase:self.reg[SR]|=1<<4
    else:u.mem_write(BASE+(sector-1)*SLOT,b'\xff'*SLOT)
  elif 0x08000000<=a<0x08080000:
   assert BASE<=a<BASE+2*SLOT and n==1,(hex(a),n)
   assert self.reg[CR]&1 and not self.reg[CR]&(1<<31)
   assert u.reg_read(UC_ARM_REG_PRIMASK)&1
   self.program.append((a,v))
   if self.fail_program:self.reg[SR]|=1<<4
 def flag(self,name,value):self.put(self.sym[name],value)
 def call(self,name,*args):
  for r,v in zip([UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2],args):self.u.reg_write(r,v)
  self.u.reg_write(UC_ARM_REG_SP,0x2000fff0);self.u.reg_write(UC_ARM_REG_LR,0x08000001)
  self.u.emu_start(self.sym[name]|1,0x08000000,count=2000000)
  assert self.u.reg_read(UC_ARM_REG_PC)==0x08000000,'execution budget reached'
  return self.u.reg_read(UC_ARM_REG_R0)
class Flash(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.t=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.t.cleanup);p=Path(cls.t.name);cls.elf=p/'flash.elf'
  (p/'stub.c').write_text('''#include "board/board.h"
#include "flight/arming.h"
unsigned armed,bench,cal,deny;
static board_t b={.board_id="matek_f722_px"};
const board_t *board_get(void){return &b;}bool board_mmio_permitted(void){return !deny;}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}bool gyro_manual_calibration_active(void){return cal;}
void wrong_board(void){b.board_id[0]='x';}
''')
  (p/'link.ld').write_text('MEMORY { F(rx): ORIGIN = 0x08010000, LENGTH = 448K\n R(rwx): ORIGIN = 0x20000000, LENGTH = 64K }\nSECTIONS { .text : { *(.text*) *(.rodata*) } > F\n .ARM.exidx : { *(.ARM.exidx*) } > F\n .data : { *(.data*) } > R AT > F\n .bss : { *(.bss*) *(COMMON) } > R }')
  cmd=['arm-none-eabi-gcc','-mcpu=cortex-m7','-mthumb','-mfpu=fpv5-sp-d16','-mfloat-abi=hard','-Os','-ffreestanding','-fno-builtin','-DBOBFLIGHT_CONFIG_FLASH_F722=1','-DBOBFLIGHT_HAVE_CMSIS=1','-I'+str(ROOT/'src'),'-I'+str(ROOT/'include'),'-I'+str(ROOT/'third_party/cmsis-core/Include'),'-I'+str(ROOT/'src/hal/stm32f7'),str(ROOT/'src/hal/stm32f7/flash_f722.c'),str(p/'stub.c'),'-nostdlib','-T'+str(p/'link.ld'),'-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(cls.elf)]
  subprocess.run(cmd,check=True,capture_output=True)
 def test_identity_geometry_and_backend(self):
  m=Machine(self.elf);self.assertEqual(m.call('hal_flash_supported'),1);self.assertEqual(m.call('hal_flash_geometry',0x20008000),1)
  self.assertEqual(struct.unpack('<5I',m.u.mem_read(0x20008000,20)),(0,SLOT,SLOT,SLOT,1))
  ptr=m.call('hal_flash_backend');self.assertEqual(bytes(m.u.mem_read(ptr,6)),b'flash\0')
 def test_erase_slots_isolated_and_watchdog_restored(self):
  for i in (0,1):
   m=Machine(self.elf);m.u.mem_write(BASE,b'\x12'*(2*SLOT));self.assertEqual(m.call('hal_flash_erase_slot',i),1)
   self.assertEqual(m.sectors,[i+1]);self.assertEqual(bytes(m.u.mem_read(BASE+i*SLOT,SLOT)),b'\xff'*SLOT)
   self.assertEqual(bytes(m.u.mem_read(BASE+(1-i)*SLOT,SLOT)),b'\x12'*SLOT)
   self.assertEqual((m.get(0x40003004),m.get(0x40003008)),(3,511));self.assertEqual(m.u.reg_read(UC_ARM_REG_PRIMASK),0)
 def test_program_readback_and_no_zero_to_one(self):
  m=Machine(self.elf);data=b'config-record';m.u.mem_write(0x20009000,data)
  self.assertEqual(m.call('hal_flash_write',SLOT,0x20009000,len(data)),1);self.assertEqual(m.call('hal_flash_read',SLOT,0x20008000,len(data)),1)
  self.assertEqual(bytes(m.u.mem_read(0x20008000,len(data))),data);self.assertTrue(all(BASE+SLOT<=a<BASE+2*SLOT for a,v in m.program))
  m.u.mem_write(0x20009000,b'\xff'*len(data));self.assertEqual(m.call('hal_flash_write',SLOT,0x20009000,len(data)),0)
 def test_wrong_identity_and_runtime_guards_no_writes(self):
  for mode in ['device','density','board','armed','bench','cal','deny']:
   m=Machine(self.elf)
   if mode=='device':m.put(0xe0042000,0x449)
   elif mode=='density':m.u.mem_write(0x1ff07a22,struct.pack('<H',1024))
   elif mode=='board':m.call('wrong_board')
   else:m.flag(mode,1)
   self.assertEqual(m.call('hal_flash_erase_slot',0),0,mode);self.assertEqual(m.call('hal_flash_write',0,0x20009000,4),0,mode)
   self.assertFalse(m.keys or m.sectors or m.program,mode)
 def test_interrupt_and_cache_state_restored(self):
  for masked in (0,1):
   m=Machine(self.elf);m.u.reg_write(UC_ARM_REG_PRIMASK,masked);m.put(0xe000ed14,1<<16)
   self.assertEqual(m.call('hal_flash_erase_slot',0),1)
   self.assertEqual(m.u.reg_read(UC_ARM_REG_PRIMASK),masked);self.assertTrue(m.get(0xe000ed14)&(1<<16))
   m.u.mem_write(0x20009000,b'XYZ');self.assertEqual(m.call('hal_flash_write',0,0x20009000,3),1)
   self.assertEqual(m.u.reg_read(UC_ARM_REG_PRIMASK),masked);self.assertTrue(m.get(0xe000ed14)&(1<<16))
 def test_bounds_lock_and_errors(self):
  m=Machine(self.elf)
  for off,n in [(2*SLOT,1),(2*SLOT-1,2),(0xffffffff,8)]:self.assertEqual(m.call('hal_flash_write',off,0x20009000,n),0)
  self.assertEqual(m.call('hal_flash_write',0,BASE,4),0);self.assertEqual(m.call('hal_flash_erase_slot',2),0);self.assertFalse(m.keys)
  m.fail_unlock=True;self.assertEqual(m.call('hal_flash_erase_slot',0),0);self.assertFalse(m.sectors)
  for op in ('erase','program'):
   m=Machine(self.elf);setattr(m,'fail_'+op,True)
   self.assertEqual(m.call('hal_flash_erase_slot',0) if op=='erase' else m.call('hal_flash_write',0,0x20009000,1),0)
   self.assertEqual(m.reg[CR],1<<31);self.assertEqual(m.u.reg_read(UC_ARM_REG_PRIMASK),0)
if __name__=='__main__':unittest.main(verbosity=2)
