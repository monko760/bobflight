# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Execute ARM SPI+HAL bridge+unchanged shared gyro driver on a register model.
Not hardware qualification: GPIO, real oscillator/timing and USB coexistence
require later physical integration. No host-mode sensor injection is enabled.
"""
import struct,subprocess,tempfile,unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_PRIMASK,UC_CPU_ARM_CORTEX_M4
ROOT=Path(__file__).resolve().parents[1]
HAL=ROOT/'src/hal/stm32f4'
SPI=0x40013000
FLAGS=['-std=c11','-Wall','-Wextra','-Werror','-ffreestanding','-fno-builtin','-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=hard','-Os','-ffunction-sections','-fdata-sections']

class F405SPI(unittest.TestCase):
 WITH_GPIO=False
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory(prefix='bf-f405-spi-');cls.addClassCleanup(cls.temp.cleanup)
  cls.elf=Path(cls.temp.name)/'component.elf'
  sources=[HAL/x for x in ('startup_component.c','spi_component.c','gyro_spi_bridge.c')]
  sources += [ROOT/'src'/x for x in ('drivers/gyro.c','drivers/sensor_calibration.c','flight/filter.c','flight/config.c','sched/loop_rate_setting.c')]
  sources += [ROOT/'tests/fixtures/f405_gyro_spi/entry.c']
  if cls.WITH_GPIO:sources.append(HAL/'gyro_gpio_prepare.c')
  cmd=['arm-none-eabi-gcc',*FLAGS,'-DBF_F4_COMPONENT_F405XG','-DBOBFLIGHT_HOST=0','-I'+str(ROOT/'src'),'-nostdlib',*[str(p) for p in sources],'-Wl,-L,'+str(ROOT/'cmake/components'),'-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),'-Wl,--gc-sections,--build-id=none','-Wl,--start-group','-lc','-lm','-lgcc','-Wl,--end-group','-o',str(cls.elf)]
  if cls.WITH_GPIO:cmd.insert(1,'-DBF_F405_TEST_REAL_GPIO')
  r=subprocess.run(cmd,capture_output=True,text=True,timeout=60)
  if r.returncode:raise RuntimeError(r.stdout+r.stderr)

 def run_model(self,case=0,mode='success',freeze=False):
  with self.elf.open('rb') as f:
   elf=ELFFile(f);symbols={s.name:int(s['st_value']) for s in elf.get_section_by_name('.symtab').iter_symbols()}
   cpu=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);cpu.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
   for base,size in [(0x08000000,0x100000),(0x20000000,0x20000),(0x10000000,0x10000),(0xe000e000,0x1000),(0x40013000,0x1000),(0x40023000,0x1000)]:cpu.mem_map(base,size)
   if self.WITH_GPIO:cpu.mem_map(0x40020000,0x1000)
   for seg in elf.iter_segments():
    if seg['p_type']=='PT_LOAD' and seg['p_filesz']:cpu.mem_write(seg['p_paddr'],seg.data())
   sp,pc=struct.unpack('<II',elf.get_section_by_name('.isr_vector').data()[:8]);cpu.reg_write(UC_ARM_REG_SP,sp)
   def read(name):return struct.unpack('<I',cpu.mem_read(symbols[name],4))[0]
   def poke(address,v,size=4):cpu.mem_write(address,int(v).to_bytes(size,'little'))
   sensor=bytearray(128);sensor[0x75]=0x69 if case==1 else 0x68;sensor[0x3a]=1
   for addr,value in [(0x3b,2048),(0x3d,1024),(0x3f,4096),(0x43,164),(0x45,-328),(0x47,492)]:sensor[addr:addr+2]=struct.pack('>h',value)
   reg={SPI:0,SPI+4:0,SPI+8:2,SPI+12:0,SPI+28:0,0x40023844:0}
   if self.WITH_GPIO:
    reg[0x40023830]=0
    for base in (0x40020000,0x40020800):
     for off in (0,4,8,12,16,20,24,28,32,36):reg[base+off]=0
   if mode=='active_spi':reg[SPI]=0x347
   selected=False;offset=0;address=0;reading=False;pending=False;ovr_dr=False;ovr_cleared=False
   tx_count=0;status_reads=0;done=[];writes=[]
   def oncode(uc,addr,size,user):
    if addr==(symbols['bf_f4_component_entry']&~1):
     poke(symbols['fixture_case'],case);poke(symbols['fixture_freeze'],int(freeze));poke(symbols['fixture_time_fail'],int(mode=='time_fail'))
    if addr==(symbols['fixture_done']&~1):done.append(True);uc.emu_stop()
   def write(uc,access,addr,size,value,user):
    nonlocal selected,offset,address,reading,pending,tx_count
    if addr==symbols['fixture_cs']:
     if not self.WITH_GPIO:selected=bool(value);offset=0
     return
    if 0x40000000<=addr<0x50000000:
     self.assertIn(addr,reg,('unexpected peripheral write',hex(addr)));writes.append((addr,size,value))
     if self.WITH_GPIO and addr==0x40020018:
      self.assertIn(value,(16,1<<20))
      reg[0x40020014]=(reg[0x40020014]|(value&65535))&~(value>>16)
      selected=not bool(reg[0x40020014]&16);offset=0;return
     if addr==SPI+12:
      self.assertEqual(size,1);self.assertTrue(selected);self.assertTrue(reg[SPI]&64)
      tx_count+=1
      if offset==0:address=value&127;reading=bool(value&128);out=0
      elif reading:
       out=sensor[address]
       if address==0x3a:sensor[0x3a]=0
       address=(address+1)&127
      else:
       out=0;sensor[address]=8 if case==2 and address==0x1c else value;address=(address+1)&127
      reg[SPI+12]=out;pending=True;offset+=1
     else:
      self.assertEqual(size,4)
      if addr==SPI+4:self.assertEqual(value,0,'F7 DS/FRXTH bits forbidden on F405')
      if addr==SPI and value&64:self.assertIn((value>>3)&7,(6,7),'MPU general register clock exceeds 1MHz')
      if mode=='clock_refused' and addr==0x40023844:value &= ~(1<<12)
      if mode=='spe_refused' and addr==SPI:value &= ~64
      reg[addr]=value
   def load(uc,access,addr,size,value,user):
    nonlocal pending,status_reads,ovr_dr,ovr_cleared
    self.assertIn(addr,reg,('unexpected peripheral read',hex(addr)))
    if addr==SPI+8:
     status_reads+=1;sr=2|(1 if pending else 0)
     failing=selected and read('fixture_phase')>0
     if failing:
      if mode=='txe':sr&=~2
      if mode=='rxne' or (case==3 and read('fixture_phase')==2):sr&=~1
      if mode=='bsy' and offset>=2:sr|=128
      if mode=='ovr' and not ovr_cleared:sr|=64
      if mode=='modf':sr|=32
     if ovr_dr:sr&=~64;ovr_cleared=True;ovr_dr=False
     poke(addr,sr);return
    if addr==SPI+12:
     self.assertEqual(size,1);pending=False
     if mode=='ovr' and selected:ovr_dr=True
     poke(addr,reg[addr],1);return
    poke(addr,reg[addr],size)
   cpu.hook_add(UC_HOOK_CODE,oncode)
   cpu.hook_add(UC_HOOK_MEM_WRITE,write)
   for lo,hi in [(SPI,SPI+0xff),(0x40023800,0x400238ff)]:cpu.hook_add(UC_HOOK_MEM_READ,load,begin=lo,end=hi)
   if self.WITH_GPIO:cpu.hook_add(UC_HOOK_MEM_READ,load,begin=0x40020000,end=0x40020fff)
   cpu.emu_start(pc,0,count=600000)
   self.assertTrue(done,'component exceeded instruction budget');self.assertEqual(read('fixture_error'),0,'C assertion line')
   self.assertEqual(cpu.reg_read(UC_ARM_REG_PRIMASK),int(case>=200 and case!=203),'PRIMASK changed unexpectedly')
   self.assertFalse(selected)
   return dict(status=read('fixture_status'),polls=read('fixture_polls'),elapsed=read('fixture_elapsed'),sr_reads=status_reads,cr1=reg[SPI],tx_count=tx_count,ovr_cleared=ovr_cleared,samples=read('fixture_sample_seq'),writes=writes)

 def test_init_invalid_parameters_context_and_time_do_not_touch_peripherals(self):
  for case,expected in [(201,1),(202,3),(203,2),(204,1),(205,10)]:
   with self.subTest(case=case):
    r=self.run_model(case=case);self.assertEqual(r['status'],expected);self.assertEqual(r['writes'],[])
 def test_clock_enable_active_peripheral_and_rejected_control_fail_closed(self):
  for case,mode,expected in [(200,'clock_refused',3),(206,'active_spi',9),(207,'spe_refused',11)]:
   with self.subTest(mode=mode):
    r=self.run_model(case=case,mode=mode);self.assertEqual(r['status'],expected)
    if case in (200,206):self.assertEqual([a for a,_,_ in r['writes']],[0x40023844])
    else:self.assertFalse(r['cr1']&64)
 def test_shared_mpu6000_identification_configuration_orientation_and_freshness(self):
  r=self.run_model();self.assertEqual(r['samples'],1)
 def test_shared_driver_wrong_identity_fails_closed(self):self.run_model(case=1)
 def test_shared_driver_configuration_mismatch_fails_closed(self):self.run_model(case=2)
 def test_shared_driver_transport_fault_invalidates_health(self):self.run_model(case=3)
 def test_successful_transfer_and_safe_reclock(self):self.assertEqual(self.run_model(case=100)['status'],0)
 def test_status_faults_have_finite_cleanup(self):
  for mode,expected in [('txe',4),('rxne',5),('bsy',6),('ovr',7),('modf',11)]:
   with self.subTest(mode=mode):
    r=self.run_model(case=100,mode=mode);self.assertEqual(r['status'],expected);self.assertLessEqual(r['polls'],128);self.assertFalse(r['cr1']&64)
    if mode=='ovr':self.assertTrue(r['ovr_cleared'],'OVR must clear with DR then SR')
 def test_frozen_clock_still_obeys_total_poll_budget(self):
  r=self.run_model(case=101,mode='rxne',freeze=True);self.assertEqual(r['status'],5);self.assertEqual(r['polls'],8)
 def test_deadline_covers_whole_transaction(self):
  r=self.run_model(case=102);self.assertNotEqual(r['status'],0);self.assertLess(r['polls'],128)
 def test_failed_timebase_latches_error_before_clocking(self):
  r=self.run_model(case=100,mode='time_fail');self.assertEqual(r['status'],10);self.assertEqual(r['tx_count'],0)

if __name__=='__main__':unittest.main()
