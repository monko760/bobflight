# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Bounded execution of real F405 reset/clock/time code; not cycle-accurate silicon.
Counter traces are explicit. Handler code/vector binding is tested, not NVIC delivery.
"""
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS
from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_R0
from unicorn.arm_const import UC_ARM_REG_PRIMASK, UC_ARM_REG_IPSR, UC_CPU_ARM_CORTEX_M4
from test_f405_clock_mmio import ROOT, HAL, FLAGS, RegisterModel, CPACR, VTOR

DWT,CYC,DEMCR=0xe0001000,0xe0001004,0xe000edfc
CSR,RVR,CVR,SHPR,ICSR=0xe000e010,0xe000e014,0xe000e018,0xe000ed20,0xe000ed04
MASK=(1<<32)-1

class Machine:
    def __init__(self,path,mode='ok',hz=168000000,init_mask=1,init_ipsr=0,clock_mode='success'):
        self.uc=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS)
        self.uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
        self.mode=mode;self.clock=RegisterModel(clock_mode,3)
        self.reg={DWT:0x40000000,DEMCR:0x10,CSR:0,RVR:0,CVR:0,SHPR:0x00123456,ICSR:0}
        if mode=='owned_systick':self.reg[CSR]=3
        if mode=='pending_systick':self.reg[ICSR]=1<<26
        if mode=='no_counter':self.reg[DWT]|=1<<25
        self.cycles=0xffffff00;self.auto=True;self.reads=[];self.writes=[];self.stops=[]
        for base,size in [(0x08000000,0x100000),(0x20000000,0x20000),(0xe000e000,0x1000),
                          (0xe0001000,0x1000),(0x40023000,0x1000),(0x40007000,0x1000)]:
            self.uc.mem_map(base,size)
        self.uc.mem_write(0x20000000,b'\xa5'*0x20000)
        with path.open('rb') as f:
            elf=ELFFile(f)
            self.sym={s.name:(int(s['st_value']),int(s['st_size'])) for s in elf.get_section_by_name('.symtab').iter_symbols()}
            for seg in elf.iter_segments():
                if seg['p_type']=='PT_LOAD' and seg['p_filesz']:
                    assert 0x08000000<=seg['p_paddr']<seg['p_paddr']+seg['p_filesz']<=0x080c0000
                    self.uc.mem_write(seg['p_paddr'],seg.data())
            vectors=elf.get_section_by_name('.isr_vector').data();msp,reset=struct.unpack('<II',vectors[:8])
            assert struct.unpack_from('<I',vectors,15*4)[0]==self.sym['SysTick_Handler'][0]
            assert self.sym['SysTick_Handler'][0]!=self.sym['Default_Handler'][0]
            self.uc.reg_write(UC_ARM_REG_SP,msp)
        self.phase='reset'
        boundaries={self.sym[n][0]&~1:n for n in ('fixture_ready','fixture_clock_failure','fixture_return')}
        def code(uc,address,size,user):
            if address==self.sym['bf_f4_component_entry'][0]&~1:
                self.phase='clock'
                uc.mem_write(self.sym['fixture_core_hz'][0],struct.pack('<I',hz))
            if address==self.sym['fixture_before_time'][0]&~1:
                self.phase='time';uc.reg_write(UC_ARM_REG_PRIMASK,init_mask);uc.reg_write(UC_ARM_REG_IPSR,init_ipsr)
            if address in boundaries:
                self.stops.append(boundaries[address]);uc.emu_stop()
        self.uc.hook_add(UC_HOOK_CODE,code)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self.write)
        for start,end in [(0xe0001000,0xe0001fff),(0xe000e000,0xe000efff),(0x40023000,0x40023fff),(0x40007000,0x40007fff)]:
            self.uc.hook_add(UC_HOOK_MEM_READ,self.read,begin=start,end=end)
        # Mutable health/accumulator reads must occur with ordinary IRQs masked.
        # This catches checking ready outside the critical section before an ISR.
        def private_read(uc,access,address,size,value,user):
            assert uc.reg_read(UC_ARM_REG_PRIMASK)&1, 'timing state read outside critical section'
        for n in ('s_ready','s_clock'):
            a,size=self.sym[n];self.uc.hook_add(UC_HOOK_MEM_READ,private_read,begin=a,end=a+size-1)
        self.uc.emu_start(reset,0,count=60000)
        assert self.stops and self.stops[-1] in ('fixture_ready','fixture_clock_failure')
        self.auto=False
        self.initial_writes=list(self.writes);self.initial_reads=list(self.reads)

    def read(self,uc,access,address,size,value,user):
        if address in self.clock.reg:return self.clock.read(uc,access,address,size,value,user)
        if address in (CPACR,VTOR):return
        assert address in self.reg or address==CYC,('unexpected core read',hex(address))
        assert size==4 and uc.reg_read(UC_ARM_REG_PRIMASK)&1,('unmasked/unaligned timing read',hex(address))
        self.reads.append(address)
        if address==CYC:
            if self.auto and self.mode!='stuck_counter' and self.reg[DWT]&1 and self.reg[DEMCR]&(1<<24):
                self.cycles=(self.cycles+168)&MASK
            value=self.cycles
        else:
            value=self.reg[address]
            if address==CSR:self.reg[CSR]&=~(1<<16)
        uc.mem_write(address,struct.pack('<I',value))

    def write(self,uc,access,address,size,value,user):
        if 0x20000000<=address<address+size<=0x20020000:return
        if address in self.clock.reg:return self.clock.write(uc,access,address,size,value,user)
        if address in (CPACR,VTOR):
            assert self.phase=='reset' and size==4;return
        assert address in (DEMCR,DWT,CSR,RVR,CVR,SHPR),('unexpected core write',hex(address))
        assert size==4 and uc.reg_read(UC_ARM_REG_PRIMASK)&1
        self.writes.append((address,value))
        if self.mode=='trace_reject' and address==DEMCR:return
        if self.mode=='enable_reject' and address==DWT:return
        if self.mode=='reload_reject' and address==RVR:return
        if self.mode=='priority_reject' and address==SHPR:return
        if self.mode=='systick_reject' and address==CSR:return
        if address==DWT:self.reg[DWT]=(self.reg[DWT]&~1)|(value&1)
        elif address==CSR:self.reg[CSR]=(self.reg[CSR]&~7)|(value&7)
        elif address==RVR:self.reg[RVR]=value&0xffffff
        elif address==CVR:self.reg[CVR]=0;self.reg[CSR]&=~(1<<16)
        else:self.reg[address]=value

    def value(self,name,fmt='<I'):
        return struct.unpack(fmt,bytes(self.uc.mem_read(self.sym[name][0],struct.calcsize(fmt))))[0]

    def call(self,name,arg=None,mask=0,ipsr=0):
        self.uc.reg_write(UC_ARM_REG_PRIMASK,mask);self.uc.reg_write(UC_ARM_REG_IPSR,ipsr)
        if arg is not None:self.uc.reg_write(UC_ARM_REG_R0,arg)
        self.uc.reg_write(UC_ARM_REG_LR,self.sym['fixture_return'][0]|1)
        self.stops.clear();self.uc.emu_start(self.sym[name][0]|1,0,count=20000)
        assert self.stops==['fixture_return'],(name,self.stops)
        assert self.uc.reg_read(UC_ARM_REG_PRIMASK)==mask,'caller IRQ mask was changed'
        return self.uc.reg_read(UC_ARM_REG_R0)

    def advance(self,cycles):self.cycles=(self.cycles+cycles)&MASK

class F405Timebase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cc=shutil.which('arm-none-eabi-gcc')
        if not cc:raise RuntimeError('ARM GCC is required, never silently skip')
        cls.temp=tempfile.TemporaryDirectory(prefix='bf-f405-time-');cls.addClassCleanup(cls.temp.cleanup)
        cls.dir=Path(cls.temp.name);cls.elf=cls.dir/'reset-clock-time.elf'
        sources=[HAL/n for n in ('startup_component.c','clock_plan.c','clock_start.c','clock_mmio.c','timebase.c')]
        sources.append(ROOT/'tests/fixtures/f405_timebase/entry.c')
        args=[cc,*FLAGS,'-DBF_F4_COMPONENT_F405XG','-I'+str(ROOT/'src'),'-nostdlib',*[str(s) for s in sources],
              '-Wl,-L,'+str(ROOT/'cmake/components'),'-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),
              '-Wl,--orphan-handling=error,--build-id=none,--strip-debug',
              '-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(cls.elf)]
        p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
        if p.returncode:raise RuntimeError(p.stdout)

    def test_reset_clock_time_chain(self):
        m=Machine(self.elf);self.assertEqual(m.value('fixture_time_ready'),1)
        self.assertEqual(m.reg[RVR],167999);self.assertEqual(m.reg[CSR]&7,7)
        self.assertEqual(m.reg[SHPR],0xf0123456);self.assertEqual(m.reg[DEMCR],0x01000010)
        self.assertEqual(m.reg[DWT],0x40000001)
        self.assertEqual([a for a,v in m.initial_writes],[DEMCR,DWT,RVR,CVR,SHPR,CSR])
        self.assertNotIn(CYC,[a for a,v in m.initial_writes])
        self.assertEqual(m.uc.reg_read(UC_ARM_REG_PRIMASK),1)
        failed=Machine(self.elf,clock_mode='hse_timeout')
        self.assertEqual(failed.stops[-1],'fixture_clock_failure');self.assertEqual(failed.writes,[])

    def test_fractional_cycles_rollover_and_handler_fold(self):
        m=Machine(self.elf);elapsed=0
        for i,delta in enumerate([0,1,166,1,168000,0xfffff000,8192,MASK,MASK,17]):
            elapsed+=delta;m.advance(delta)
            if i%2:m.call('SysTick_Handler',mask=i%2,ipsr=15)
            self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0],mask=i%2),1)
            self.assertEqual(m.value('fixture_us','<Q'),elapsed//168)
            self.assertEqual(m.call('bf_f405_time_read_ms',m.sym['fixture_ms'][0],mask=i%2),1)
            self.assertEqual(m.value('fixture_ms'),(elapsed//168//1000)&MASK)

        # Several ISR-only folds span more than one raw wrap before foreground
        # reads. An empty handler would now lose time and fail this assertion.
        for delta in (0xf0000000,)*3:
            elapsed+=delta;m.advance(delta);m.call('SysTick_Handler',ipsr=15)
        self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0]),1)
        self.assertEqual(m.value('fixture_us','<Q'),elapsed//168)

    def test_large_epoch_millisecond_wrap(self):
        m=Machine(self.elf)
        # White-box epoch seed avoids billions of simulated ticks. Arithmetic
        # accumulation itself is exercised above and by existing host cycle tests.
        epoch=((1<<32)-1)*1000+999
        m.uc.mem_write(m.sym['s_clock'][0],struct.pack('<Q',epoch))
        self.assertEqual(m.call('bf_f405_time_read_ms',m.sym['fixture_ms'][0]),1)
        self.assertEqual(m.value('fixture_ms'),MASK)
        m.advance(168)
        self.assertEqual(m.call('bf_f405_time_read_ms',m.sym['fixture_ms'][0]),1)
        self.assertEqual(m.value('fixture_ms'),0)
        self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0]),1)
        self.assertEqual(m.value('fixture_us','<Q'),epoch+1)

    def test_invalid_initialization_and_ownership(self):
        for hz in (0,500000,168000001,169000000):
            with self.subTest(hz=hz):
                m=Machine(self.elf,hz=hz);self.assertEqual(m.value('fixture_time_ready'),0)
                self.assertEqual(m.reads,[]);self.assertEqual(m.writes,[])
        for kwargs in ({'init_mask':0},{'init_ipsr':15},{'mode':'owned_systick'},{'mode':'pending_systick'}):
            with self.subTest(kwargs=kwargs):
                m=Machine(self.elf,**kwargs);self.assertEqual(m.value('fixture_time_ready'),0)
                self.assertEqual(m.writes,[])

    def test_hardware_init_failure_is_latched(self):
        for mode in ('trace_reject','no_counter','enable_reject','stuck_counter','reload_reject','priority_reject','systick_reject'):
            with self.subTest(mode=mode):
                m=Machine(self.elf,mode=mode);self.assertEqual(m.value('fixture_time_ready'),0)
                writes=len(m.writes);m.mode='ok';m.reg[DWT]&=~(1<<25)
                self.assertEqual(m.call('bf_f405_time_init',168000000,mask=1),0)
                self.assertEqual(len(m.writes),writes)
                self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0]),0)
                self.assertEqual(m.value('fixture_us','<Q'),0x1122334455667788)
                self.assertEqual(m.call('bf_f405_time_read_ms',m.sym['fixture_ms'][0]),0)
                self.assertEqual(m.value('fixture_ms'),0xaabbccdd)
                self.assertEqual(m.reg[CSR]&3,0)

    def test_runtime_health_loss_never_recovers_silently(self):
        for reg,broken in ((DEMCR,0),(DWT,0x40000000),(DWT,0x42000001),(CSR,5),(RVR,100)):
            for from_isr in (False,True):
                with self.subTest(reg=hex(reg),isr=from_isr):
                    m=Machine(self.elf);good=m.reg[reg];m.reg[reg]=broken
                    if from_isr:m.call('SysTick_Handler',ipsr=15)
                    else:self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0]),0)
                    m.reg[reg]=good
                    self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0],mask=1),0)
                    self.assertEqual(m.value('fixture_us','<Q'),0x1122334455667788)
                    self.assertEqual(m.call('bf_f405_time_read_ms',m.sym['fixture_ms'][0]),0)
                    self.assertEqual(m.value('fixture_ms'),0xaabbccdd)

    def test_null_nonmaskable_and_reinit_guards(self):
        m=Machine(self.elf);reads=len(m.reads);writes=len(m.writes)
        for name in ('bf_f405_time_read_us','bf_f405_time_read_ms'):
            self.assertEqual(m.call(name,0),0)
            for ipsr in (2,3):self.assertEqual(m.call(name,m.sym['fixture_us'][0],ipsr=ipsr),0)
        self.assertEqual(len(m.reads),reads);self.assertEqual(len(m.writes),writes)
        self.assertEqual(m.call('bf_f405_time_init',168000000,mask=1),0)
        self.assertEqual(len(m.writes),writes)
        m.advance(168000);self.assertEqual(m.call('bf_f405_time_read_us',m.sym['fixture_us'][0]),1)
        self.assertEqual(m.value('fixture_us','<Q'),1000)

    def test_compile_part_guards(self):
        for defs in ([],['-DBF_F4_COMPONENT_F411XE'],['-DBF_F4_COMPONENT_F405XG','-DBF_F4_COMPONENT_F411XE']):
            args=[shutil.which('arm-none-eabi-gcc'),*FLAGS,*defs,'-I'+str(ROOT/'src'),
                  '-c',str(HAL/'timebase.c'),'-o',str(self.dir/'bad.o')]
            p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            self.assertNotEqual(p.returncode,0,p.stdout);self.assertIn('error:',p.stdout)

if __name__=='__main__':unittest.main(verbosity=2)
