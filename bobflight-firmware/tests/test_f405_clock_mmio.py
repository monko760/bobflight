# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Execute real F405 reset/clock/volatile-MMIO code against a bounded register model.
This verifies software wiring and failure paths, NOT oscillator/silicon behavior.
"""
import collections
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS
from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_PRIMASK, UC_CPU_ARM_CORTEX_M4

ROOT=Path(__file__).resolve().parents[1]
HAL=ROOT/'src/hal/stm32f4'
FLAGS=['-std=c11','-Wall','-Wextra','-Werror','-ffreestanding','-fno-builtin',
       '-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=hard','-Os']
# Addresses independently checked from ST RCC/PWR/FLASH structs and base macros,
# cmsis-device-f4 9192c7b9df75a142f2027ab266601fe061fc00b3, STM32F405 header.
CR,PLL,CFGR,APB1=0x40023800,0x40023804,0x40023808,0x40023840
PWR,CSR,FLASH=0x40007000,0x40007004,0x40023c00
CPACR,VTOR=0xe000ed88,0xe000ed08

class RegisterModel:
    def __init__(self,mode,delay):
        self.mode,self.delay=mode,delay
        self.reg={CR:0x83,PLL:0x24003010,CFGR:0,APB1:0,PWR:0x4000,CSR:0,FLASH:0}
        self.writes=[];self.reads=[];self.polls=collections.Counter()
        if mode=='pending_switch':self.reg[CFGR]=2
        if mode=='running_pll':self.reg[CR]|=(1<<24)|(1<<25)
        if mode=='hse_bypass':self.reg[CR]|=1<<18
        if mode=='missing_hsi':self.reg[CR]&=~2

    def read(self,uc,access,address,size,value,user):
        assert address in self.reg and size==4,('unexpected MMIO read',hex(address),size)
        assert uc.reg_read(UC_ARM_REG_PRIMASK)&1, 'unmasked MMIO read'
        if address in (PWR,CSR):assert self.reg[APB1]&(1<<28), 'PWR interface clock not enabled'
        self.reads.append(address)
        if address==CR:
            for tag,on,ready,fail in [('hse',16,17,'hse_timeout'),('pll',24,25,'pll_timeout')]:
                if self.reg[CR]&(1<<on):
                    self.polls[tag]+=1
                    prerequisite=tag!='pll' or self.reg[CR]&(1<<17)
                    if prerequisite and self.polls[tag]>=self.delay and self.mode!=fail:
                        self.reg[CR]|=1<<ready
        elif address==CSR and self.reg[CR]&(1<<25):
            self.polls['vos']+=1
            if self.polls['vos']>=self.delay and self.mode!='vos_timeout':self.reg[CSR]|=1<<14
        elif address==CFGR and self.reg[CFGR]&3==2:
            self.polls['switch']+=1
            if self.polls['switch']>=self.delay and self.mode!='switch_timeout':self.reg[CFGR]|=8
        uc.mem_write(address,struct.pack('<I',self.reg[address]))

    def write(self,uc,access,address,size,value,user):
        assert address in self.reg and address!=CSR and size==4,('unexpected MMIO write',hex(address),size)
        assert uc.reg_read(UC_ARM_REG_PRIMASK)&1, 'unmasked MMIO write'
        if address==PWR:assert self.reg[APB1]&(1<<28), 'PWR interface clock not enabled'
        if address==PLL:assert not self.reg[CR]&((1<<24)|(1<<25)), 'reprogramming active PLL'
        if address==CFGR and value&3==2:
            assert self.reg[CR]&(1<<25) and self.reg[CSR]&(1<<14), 'switch before readiness'
            assert self.reg[FLASH]&7==5, 'switch before flash latency'
        self.writes.append((address,value))
        if address==CR:
            readonly=(1<<1)|(1<<17)|(1<<25)|(1<<27)
            self.reg[address]=(value&~readonly)|(self.reg[address]&readonly)
        elif address==CFGR:
            if self.mode=='switch_reject' and value&3==2:value&=~3
            self.reg[address]=(value&~12)|(self.reg[address]&12)
        elif address==FLASH and self.mode=='flash_reject':self.reg[address]=value&~7
        else:self.reg[address]=value


def execute(path,mode='success',delay=3,inputs=None,unmasked=False):
    with path.open('rb') as f:
        elf=ELFFile(f)
        symbols={s.name:(int(s['st_value']),int(s['st_size'])) for s in elf.get_section_by_name('.symtab').iter_symbols()}
        uc=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
        for base,size in [(0x08000000,0x100000),(0x20000000,0x20000),(0xe000e000,0x1000),(0x40023000,0x1000),(0x40007000,0x1000)]:uc.mem_map(base,size)
        uc.mem_write(0x20000000,b'\xa5'*0x20000)
        for seg in elf.iter_segments():
            if seg['p_type']=='PT_LOAD' and seg['p_filesz']:
                assert 0x08000000<=seg['p_paddr']<seg['p_paddr']+seg['p_filesz']<=0x080c0000
                uc.mem_write(seg['p_paddr'],seg.data())
        vectors=elf.get_section_by_name('.isr_vector');msp,reset=struct.unpack('<II',vectors.data()[:8])
        assert msp==0x20020000 and reset&1
        uc.reg_write(UC_ARM_REG_SP,msp)
        model=RegisterModel(mode,delay);entry_seen=[];stopped=[];system_writes=[];initial_clocks=[]
        def read_symbol(name):
            address,size=symbols[name];return bytes(uc.mem_read(address,size))
        def read_u32(name):return struct.unpack('<I',read_symbol(name))[0]
        stops={symbols[n][0]&~1:n for n in ('fixture_success','fixture_failure','fixture_probe_done')}
        def code(cpu,address,size,user):
            if address==symbols['bf_f4_component_entry'][0]&~1:
                assert not entry_seen;entry_seen.append(True)
                for name in ('.data','.bss','.dma_bss','.noinit'):
                    sec=elf.get_section_by_name(name);assert sec is not None and sec['sh_size']
                    expected=sec.data() if name=='.data' else (b'\xa5' if name=='.noinit' else b'\0')*sec['sh_size']
                    assert bytes(cpu.mem_read(sec['sh_addr'],sec['sh_size']))==expected,name
                initial_clocks.append(read_symbol('fixture_clocks'))
                for name,value in (inputs or {}).items():cpu.mem_write(symbols[name][0],struct.pack('<I',value))
                if unmasked:cpu.reg_write(UC_ARM_REG_PRIMASK,0)
            if address in stops:
                stopped.append(stops[address]);cpu.emu_stop()
        def writes(cpu,access,address,size,value,user):
            if 0x20000000<=address<address+size<=0x20020000:return
            if address in (CPACR,VTOR):
                assert size==4 and not entry_seen
                system_writes.append((address,value));return
            assert entry_seen,('MMIO before reset memory init',hex(address))
            model.write(cpu,access,address,size,value,user)
        uc.hook_add(UC_HOOK_CODE,code)
        uc.hook_add(UC_HOOK_MEM_WRITE,writes)
        for start,end in [(0x40023000,0x40023fff),(0x40007000,0x40007fff)]:
            uc.hook_add(UC_HOOK_MEM_READ,model.read,begin=start,end=end)
        uc.emu_start(reset,0,count=60000)
        assert entry_seen and len(stopped)==1,'did not reach bounded terminal stage'
        assert [a for a,v in system_writes]==[CPACR,VTOR]
        assert system_writes[0][1]&0x00f00000==0x00f00000 and system_writes[1][1]==0x08000000
        assert uc.reg_read(UC_ARM_REG_PRIMASK)==int(not unmasked)
        assert read_symbol('fixture_noinit')==b'\xa5'*4
        assert read_symbol('fixture_dma')==bytes(32)
        return {'stop':stopped[0],'status':read_u32('fixture_status'),'clocks':read_symbol('fixture_clocks'),
                'initial_clocks':initial_clocks[0],'model':model,'probe_failures':read_u32('fixture_probe_failures'),
                'probe_result':read_u32('fixture_probe_result')}


class F405ResetClockMMIO(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cc=shutil.which('arm-none-eabi-gcc')
        if not cls.cc:raise RuntimeError('ARM GCC required, never silently skip')
        cls.temp=tempfile.TemporaryDirectory(prefix='bf-f405-clock-mmio-');cls.addClassCleanup(cls.temp.cleanup)
        cls.dir=Path(cls.temp.name);cls.elf=cls.dir/'reset-clock.elf'
        sources=[HAL/n for n in ('startup_component.c','clock_plan.c','clock_start.c','clock_mmio.c')]
        sources.append(ROOT/'tests/fixtures/f405_clock_mmio/entry.c')
        args=[cls.cc,*FLAGS,'-DBF_F4_COMPONENT_F405XG','-I'+str(ROOT/'src'),'-nostdlib',*[str(s) for s in sources],
              '-Wl,-L,'+str(ROOT/'cmake/components'),'-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),
              '-Wl,--orphan-handling=error,--build-id=none,--strip-debug',
              '-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(cls.elf)]
        result=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
        if result.returncode:raise RuntimeError(result.stdout)

    def test_success_reset_to_real_mmio(self):
        for hse in (8000000,25000000):
            for delay in (1,3,8):
                with self.subTest(hse=hse,delay=delay):
                    r=execute(self.elf,delay=delay,inputs={'fixture_hse_hz':hse})
                    self.assertEqual(r['stop'],'fixture_success');self.assertEqual(r['status'],0)
                    values=struct.unpack('<8I',r['clocks'][:32])
                    self.assertEqual(values,(hse,168000000,168000000,48000000,42000000,84000000,84000000,168000000))
                    m=r['model'];self.assertEqual([a for a,v in m.writes],[APB1,PWR,FLASH,CFGR,PLL,CR,CR,CFGR])
                    self.assertEqual(m.reg[FLASH]&7,5);self.assertEqual(m.reg[PWR]&0x4000,0x4000)
                    self.assertEqual(m.reg[CFGR]&15,10);self.assertEqual(m.reg[PLL]&63,hse//1000000)
                    self.assertEqual(m.reg[PLL]&0x20000000,0x20000000,'unrelated PLL bit lost')

    def test_bounded_failure_paths(self):
        for mode,status in [('flash_reject',5),('hse_timeout',6),('pll_timeout',7),('vos_timeout',8),('switch_timeout',9),('switch_reject',11)]:
            with self.subTest(mode=mode):
                r=execute(self.elf,mode)
                self.assertEqual(r['stop'],'fixture_failure');self.assertEqual(r['status'],status)
                self.assertEqual(r['clocks'],r['initial_clocks'])
                self.assertLess(len(r['model'].reads),80)
                if mode not in ('switch_timeout','switch_reject'):
                    self.assertFalse(any(a==CFGR and v&3==2 for a,v in r['model'].writes))

        short=execute(self.elf,delay=3,inputs={'fixture_budget':1})
        self.assertEqual(short['status'],6);self.assertEqual(short['model'].polls['hse'],2)
        self.assertEqual(short['stop'],'fixture_failure');self.assertEqual(short['clocks'],short['initial_clocks'])

    def test_unsafe_reset_states_do_not_write(self):
        for mode in ('pending_switch','running_pll','hse_bypass','missing_hsi'):
            with self.subTest(mode=mode):
                r=execute(self.elf,mode);self.assertEqual(r['status'],2)
                self.assertEqual(r['stop'],'fixture_failure');self.assertEqual(r['model'].writes,[])
                self.assertEqual(r['clocks'],r['initial_clocks'])

    def test_invalid_inputs_do_not_access_mmio(self):
        for inputs in ({'fixture_hse_hz':0},{'fixture_hse_hz':8000001},{'fixture_vdd_mv':2600},{'fixture_budget':0},{'fixture_null_output':1}):
            with self.subTest(inputs=inputs):
                r=execute(self.elf,inputs=inputs);self.assertEqual(r['status'],1)
                self.assertEqual(r['model'].reads,[]);self.assertEqual(r['model'].writes,[])
                self.assertEqual(r['clocks'],r['initial_clocks'])

    def test_interrupts_must_be_masked(self):
        r=execute(self.elf,unmasked=True);self.assertEqual(r['status'],2)
        self.assertEqual(r['stop'],'fixture_failure');self.assertEqual(r['clocks'],r['initial_clocks'])
        self.assertEqual(r['model'].reads,[]);self.assertEqual(r['model'].writes,[])

    def test_adapter_rejects_invalid_access(self):
        r=execute(self.elf,inputs={'fixture_probe_only':1})
        self.assertEqual(r['stop'],'fixture_probe_done');self.assertEqual(r['probe_failures'],0)
        self.assertEqual(r['probe_result'],0xcafebabe)
        self.assertEqual(r['model'].reads,[]);self.assertEqual(r['model'].writes,[])

    def test_compile_part_guards(self):
        for defs in ([],['-DBF_F4_COMPONENT_F411XE'],['-DBF_F4_COMPONENT_F405XG','-DBF_F4_COMPONENT_F411XE']):
            args=[self.cc,*FLAGS,*defs,'-c',str(HAL/'clock_mmio.c'),'-o',str(self.dir/'bad.o')]
            result=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            self.assertNotEqual(result.returncode,0,result.stdout)
            self.assertIn('error:',result.stdout)

if __name__=='__main__':unittest.main(verbosity=2)
