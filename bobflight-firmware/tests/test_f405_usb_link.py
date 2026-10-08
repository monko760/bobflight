# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Link real TinyUSB with F405 reset/time; execute descriptors, not USB hardware."""
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import UC_HOOK_MEM_READ, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_LR, UC_ARM_REG_PRIMASK, UC_ARM_REG_IPSR
from test_f405_timebase import Machine, ROOT, HAL, FLAGS

TUSB=ROOT/'third_party/tinyusb/src'
class IRQMachine(Machine):
    def __init__(self,*args,**kwargs):
        self.nvic_writes=[];super().__init__(*args,**kwargs)
    def call(self,name,arg=None,mask=0,ipsr=0):
        self.uc.reg_write(UC_ARM_REG_PRIMASK,mask);self.uc.reg_write(UC_ARM_REG_IPSR,ipsr)
        if arg is not None:self.uc.reg_write(UC_ARM_REG_R0,arg)
        self.uc.reg_write(UC_ARM_REG_LR,self.sym['fixture_return'][0]|1)
        self.stops.clear();self.uc.emu_start(self.sym[name][0]|1,0,count=20000)
        # Unicorn may re-report a stop boundary after a system-register write.
        assert self.stops and all(s=='fixture_return' for s in self.stops)
        assert self.uc.reg_read(UC_ARM_REG_PRIMASK)==mask
        return self.uc.reg_read(UC_ARM_REG_R0)
    def write(self,uc,access,address,size,value,user):
        if address in (0xe000e108,0xe000e188):
            assert size==4;self.nvic_writes.append((address,value));return
        return super().write(uc,access,address,size,value,user)

class F405USBLink(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cc=shutil.which('arm-none-eabi-gcc')
        if not cls.cc:raise RuntimeError('ARM GCC required')
        cls.tmp=tempfile.TemporaryDirectory(prefix='bf-f405-usb-link-');cls.addClassCleanup(cls.tmp.cleanup)
        cls.dir=Path(cls.tmp.name);cls.images={}
        cls.includes=['-I'+str(p) for p in (ROOT/'src',HAL,TUSB,ROOT/'third_party/cmsis-core/Include')]
        cls.defs=['-DBF_F4_COMPONENT_F405XG','-DCFG_TUSB_MCU=OPT_MCU_STM32F4'] + getattr(cls,'EXTRA_DEFS',[])
        sources=[HAL/n for n in ('startup_component.c','clock_plan.c','clock_start.c','clock_mmio.c','timebase.c','usb_time.c')]
        sources += [ROOT/'tests/fixtures/f405_timebase/entry.c',ROOT/'tests/fixtures/f405_usb_link/hooks.c']
        sources += [TUSB/n for n in ('tusb.c','common/tusb_fifo.c','device/usbd.c','class/cdc/cdc_device.c',
                                    'portable/synopsys/dwc2/dcd_dwc2.c','portable/synopsys/dwc2/dwc2_common.c')]
        sources += getattr(cls,'EXTRA_SOURCES',[])
        objects=[]
        for i,src in enumerate(sources):
            obj=cls.dir/f'source-{i}.o';cls.run_cmd([cls.cc,*FLAGS,*cls.includes,*cls.defs,'-c',str(src),'-o',str(obj)]);objects.append(str(obj))
        for name in ('f405','f722','f745'):
            obj=cls.dir/f'descriptor-{name}.o'
            inc=cls.includes if name=='f405' else ['-I'+str(ROOT/'src/hal/stm32f7'),*[a for a in cls.includes if a!='-I'+str(HAL)]]
            defs=cls.defs if name=='f405' else ['-DCFG_TUSB_MCU=OPT_MCU_STM32F7']
            if name=='f722':defs=defs+['-DBOBFLIGHT_TARGET_MCU_STM32F722=1']
            cls.run_cmd([cls.cc,*FLAGS,*inc,*defs,'-c',str(ROOT/'src/usb/usb_descriptors.c'),'-o',str(obj)])
            image=cls.dir/f'usb-{name}-descriptor.elf'
            cls.run_cmd([cls.cc,*FLAGS,'-nostdlib',*objects,str(obj),'-Wl,-L,'+str(ROOT/'cmake/components'),
                '-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),'-Wl,--orphan-handling=error,--build-id=none,--strip-debug',
                '-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(image)])
            cls.images[name]=image
    @classmethod
    def run_cmd(cls,args):
        p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
        if p.returncode:raise RuntimeError(p.stdout)
        return p.stdout

    def test_actual_stack_vectors_and_memory_bounds(self):
        with self.images['f405'].open('rb') as stream:
            elf=ELFFile(stream);symbols={s.name:int(s['st_value']) for s in elf.get_section_by_name('.symtab').iter_symbols()}
            for name in ('dcd_init','dwc2_core_init','tud_task_ext','fixture_usb_stack_init','tusb_time_millis_api'):
                self.assertIn(name,symbols);self.assertNotEqual(symbols[name],0)
            for name in ('malloc','_sbrk','snprintf'):self.assertNotIn(name,symbols)
            vectors=elf.get_section_by_name('.isr_vector').data()
            self.assertEqual(struct.unpack_from('<I',vectors,(16+67)*4)[0],symbols['OTG_FS_IRQHandler'])
            self.assertNotEqual(symbols['OTG_FS_IRQHandler'],symbols['Default_Handler'])
            for seg in elf.iter_segments():
                if seg['p_type']=='PT_LOAD' and seg['p_filesz']:
                    self.assertTrue(0x08000000<=seg['p_paddr']<seg['p_paddr']+seg['p_filesz']<=0x080c0000)

    def test_serial_address_bytes_and_cache_all_three_parts(self):
        for part,base in [('f405',0x1fff7a10),('f722',0x1ff07a10),('f745',0x1ff0f420)]:
            for words in ((0x01234567,0x89abcdef,0x00fedcba),(0,0,0),(0xffffffff,0xffffffff,0xffffffff)):
                with self.subTest(part=part,words=words):
                    m=Machine(self.images[part]);m.uc.mem_map(base&~0xfff,0x1000)
                    m.uc.mem_write(base,struct.pack('<III',*words));reads=[]
                    def record(uc,access,address,size,value,user):
                        self.assertIn(address,(base,base+4,base+8));self.assertEqual(size,4);reads.append(address)
                    m.uc.hook_add(UC_HOOK_MEM_READ,record,begin=base&~0xfff,end=(base&~0xfff)+0xfff)
                    ptr=m.call('tud_descriptor_string_cb',3)
                    descriptor=bytes(m.uc.mem_read(ptr,50));self.assertEqual(descriptor[:2],bytes([50,3]))
                    self.assertEqual(descriptor[2:].decode('utf-16-le'),''.join(f'{w:08X}' for w in reversed(words)))
                    self.assertEqual(reads,[base,base+4,base+8])
                    m.uc.mem_write(base,b'\x55'*12);m.call('tud_descriptor_string_cb',3)
                    self.assertEqual(len(reads),3);self.assertEqual(bytes(m.uc.mem_read(ptr,50)),descriptor)

    def test_clock_time_prefix_and_unprepared_usb_rejection(self):
        m=Machine(self.images['f405']);self.assertEqual(m.value('fixture_time_ready'),1)
        # No USB register range is mapped: accidental USB access fails the test.
        self.assertEqual(m.call('fixture_usb_stack_init',0),0)
        self.assertEqual(m.value('SystemCoreClock'),0)
        self.assertEqual(m.call('fixture_usb_time_bind',mask=1),1)
        m.advance(168000);self.assertEqual(m.call('tusb_time_millis_api'),1)
        self.assertEqual(m.value('SystemCoreClock'),168000000)

    def test_time_health_failure_stops_instead_of_faking_zero(self):
        m=Machine(self.images['f405']);self.assertEqual(m.call('fixture_usb_time_bind',mask=1),1);m.reg[0xe000e010]=5;hit=[]
        def stop(uc,address,size,user):
            if address==(m.sym['bf_f405_usb_time_fault'][0]&~1):hit.append(True);uc.emu_stop()
        m.uc.hook_add(UC_HOOK_CODE,stop);m.uc.reg_write(UC_ARM_REG_LR,m.sym['fixture_return'][0]|1)
        m.uc.emu_start(m.sym['tusb_time_millis_api'][0]|1,0,count=20000)
        self.assertEqual(hit,[True])

    def test_exact_irq_registers_and_rejected_irq_numbers(self):
        m=IRQMachine(self.images['f405'])
        m.call('fixture_irq_enable',67);m.call('fixture_irq_disable',67)
        self.assertEqual(m.nvic_writes,[(0xe000e108,8),(0xe000e188,8)])
        for irq in (0,68,0xffffffff):
            m.call('fixture_irq_enable',irq);m.call('fixture_irq_disable',irq)
        self.assertEqual(len(m.nvic_writes),2)

    def test_invalid_component_and_usb_modes_rejected(self):
        source=self.dir/'guard.c';source.write_text('#include "tusb.h"\n#include "stm32f4xx.h"\n')
        for defs in (['-DCFG_TUSB_MCU=OPT_MCU_STM32F4'],self.defs+['-DBF_F4_COMPONENT_F411XE'],
                     self.defs+['-DBOARD_TUD_RHPORT=1'],self.defs+['-DBOARD_TUD_MAX_SPEED=OPT_MODE_HIGH_SPEED'],
                     self.defs+['-DCFG_TUD_DWC2_DMA_ENABLE=1'],self.defs+['-DCFG_TUD_MEM_DCACHE_ENABLE=1'],
                     self.defs+['-DUSB_OTG_FS_PERIPH_BASE=0x40000000'],self.defs+['-DUSB_OTG_FS_MAX_IN_ENDPOINTS=6'],
                     self.defs+['-DUSB_OTG_HS_PERIPH_BASE=0x40040000']):
            p=subprocess.run([self.cc,*FLAGS,*self.includes,*defs,'-c',str(source),'-o',str(self.dir/'guard.o')],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            self.assertNotEqual(p.returncode,0,p.stdout)

if __name__=='__main__':unittest.main(verbosity=2)
