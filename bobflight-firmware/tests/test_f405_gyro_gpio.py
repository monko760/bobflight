# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Execute F405 GPIO preparation on a register model, not physical qualification."""
import struct,subprocess,tempfile,unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_PRIMASK,UC_CPU_ARM_CORTEX_M4
from test_f405_spi_component import FLAGS,ROOT,HAL
A,C,EN=0x40020000,0x40020800,0x40023830
class GyroGPIO(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory(prefix='bf-f405-gyro-gpio-');cls.addClassCleanup(cls.tmp.cleanup)
  cls.elf=Path(cls.tmp.name)/'gpio.elf'
  cmd=['arm-none-eabi-gcc',*FLAGS,'-DBF_F4_COMPONENT_F405XG','-I'+str(ROOT/'src'),'-nostdlib',str(HAL/'startup_component.c'),str(HAL/'gyro_gpio_prepare.c'),str(ROOT/'tests/fixtures/f405_gyro_gpio/entry.c'),'-Wl,-L,'+str(ROOT/'cmake/components'),'-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),'-Wl,--gc-sections,--build-id=none','-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(cls.elf)]
  r=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
  if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 def execute(self,case=0,reject=None,unmasked=False):
  with self.elf.open('rb') as f:
   e=ELFFile(f);syms={s.name:int(s['st_value']) for s in e.get_section_by_name('.symtab').iter_symbols()}
   u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);u.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
   for addr,n in [(0x08000000,0x100000),(0x20000000,0x20000),(0xe000e000,0x1000),(A,0x1000),(0x40023000,0x1000)]:u.mem_map(addr,n)
   for p in e.iter_segments():
    if p['p_type']=='PT_LOAD' and p['p_filesz']:u.mem_write(p['p_paddr'],p.data())
   sp,pc=struct.unpack('<II',e.get_section_by_name('.isr_vector').data()[:8]);u.reg_write(UC_ARM_REG_SP,sp)
   regs={EN:0x00200002};masks={EN:5}
   for base in (A,C):
    for offset,value in [(0,0xffffffff),(4,0xffff),(8,0x55555555),(12,0xffffffff),(16,0),(20,0xaaaa&~16),(24,0),(28,0),(32,0x12345678),(36,0xabcdef01)]:regs[base+offset]=value
    for offset,mask in [(0,0xff00 if base==A else 3<<10),(4,0xf0 if base==A else 1<<5),(8,0xff00 if base==A else 3<<10),(12,0xff00 if base==A else 3<<10),(32,0xfff00000 if base==A else 0)]:masks[base+offset]=mask
   initial=dict(regs);writes=[];reads=[];stops=[]
   def put(addr,value):u.mem_write(addr,struct.pack('<I',value))
   def val(name):return struct.unpack('<I',u.mem_read(syms[name],4))[0]
   def code(cpu,addr,n,ctx):
    if addr==(syms['bf_f4_component_entry']&~1):
     put(syms['fixture_case'],case)
     if unmasked:cpu.reg_write(UC_ARM_REG_PRIMASK,0)
    if addr==(syms['fixture_done']&~1):stops.append(True);cpu.emu_stop()
   def check_clock(addr):
    if A<=addr<A+0x400:self.assertTrue(regs[EN]&1)
    if C<=addr<C+0x400:self.assertTrue(regs[EN]&4)
   def load(cpu,access,addr,n,value,ctx):
    self.assertIn(addr,regs);self.assertEqual(n,4);check_clock(addr);reads.append(addr);put(addr,regs[addr])
   def store(cpu,access,addr,n,value,ctx):
    if not 0x40000000<=addr<0x50000000:return
    self.assertIn(addr,regs);self.assertEqual(n,4);check_clock(addr);writes.append((addr,value))
    if addr==A+24:
     self.assertIn(value,(16,1<<20),'CS must touch only PA4')
     if addr!=reject:regs[A+20]=(regs[A+20]|(value&65535))&~(value>>16)
     return
    self.assertIn(addr,masks,'unexpected GPIO/peripheral write')
    self.assertEqual(value&~masks[addr],regs[addr]&~masks[addr],'unrelated pin or clock changed')
    if addr==A and ((value>>8)&3)==1:self.assertTrue(regs[A+20]&16,'CS output before inactive latch verified')
    if addr!=reject:regs[addr]=value
   u.hook_add(UC_HOOK_CODE,code);u.hook_add(UC_HOOK_MEM_WRITE,store)
   for lo,hi in [(A,A+0xfff),(0x40023800,0x400238ff)]:u.hook_add(UC_HOOK_MEM_READ,load,begin=lo,end=hi)
   u.emu_start(pc,0,count=30000)
   self.assertTrue(stops,'not bounded');self.assertEqual(u.reg_read(UC_ARM_REG_PRIMASK),0)
   return dict(result=val('fixture_result'),again=val('fixture_again'),regs=regs,initial=initial,writes=writes,reads=reads)
 def test_setup_preserves_usb_and_unrelated_resources(self):
  r=self.execute();self.assertEqual(r['result'],0);self.assertNotEqual(r['again'],0)
  reg=r['regs'];self.assertEqual(reg[A]&0xff00,0xa900);self.assertEqual(reg[A+32]&0xfff00000,0x55500000)
  self.assertEqual(reg[C]&(3<<10),0);self.assertTrue(reg[A+20]&16)
  self.assertEqual([v for a,v in r['writes'] if a==A+24],[16,1<<20,16])
 def test_bad_routes_and_null_board_make_no_mmio_access(self):
  for case in range(1,8):
   with self.subTest(case=case):
    r=self.execute(case);self.assertNotEqual(r['result'],0);self.assertFalse(r['reads']);self.assertFalse(r['writes'])
 def test_unmasked_preparation_is_rejected(self):
  r=self.execute(unmasked=True);self.assertNotEqual(r['result'],0);self.assertFalse(r['writes']);self.assertFalse(r['reads'])
 def test_clock_and_latch_rejection_stop_before_output_enable(self):
  for reject in (EN,A+24):
   with self.subTest(reject=reject):
    r=self.execute(reject=reject);self.assertNotEqual(r['result'],0);self.assertEqual(r['regs'][A],r['initial'][A]);self.assertEqual(len([a for a,v in r['writes'] if a==EN]),1)
 def test_configuration_readback_failure_does_not_enable_callback(self):
  for reject in (A,A+4,A+8,A+12,A+32,C,C+12):
   with self.subTest(reject=reject):
    r=self.execute(reject=reject);self.assertNotEqual(r['result'],0);self.assertNotEqual(r['again'],0)
    self.assertFalse(any(a==A+24 and v==1<<20 for a,v in r['writes']))
if __name__=='__main__':unittest.main()
