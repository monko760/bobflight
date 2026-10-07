# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Offline component links, negative bounds tests and bounded reset emulation.
No board firmware build, physical register access or device flashing occurs.
"""
import json
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
from f4_reset_model import verify

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / 'tests/fixtures/f4_startup'
START = ROOT / 'src/hal/stm32f4/startup_component.c'
LINK = ROOT / 'cmake/components'
FACTS = json.loads((FIX / 'irq_facts.json').read_text())['devices']
PARTS = {
    'f405xg': ('stm32f405xx.h', 98, 0x080c0000, 0x08100000),
    'f411xe': ('stm32f411xe.h', 102, 0x08040000, 0x08080000),
}
CORE = {2:'NMI_Handler',3:'HardFault_Handler',4:'MemManage_Handler',5:'BusFault_Handler',
        6:'UsageFault_Handler',11:'SVC_Handler',12:'DebugMon_Handler',14:'PendSV_Handler',15:'SysTick_Handler'}
FLAGS = ['-std=c11','-Wall','-Wextra','-Werror','-ffreestanding','-fno-builtin',
         '-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=hard','-Os']

class StartupLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cc = shutil.which('arm-none-eabi-gcc')
        if not cls.cc:
            raise RuntimeError('ARM toolchain required; never silently skip component verification')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bf-f4-component-')
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def run_cmd(self, args):
        return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)

    def build(self, part, extra=None, linker=None, overrides=False, gc=False):
        sources = [START, FIX/'entry.c']
        if extra:
            p = self.dir/'extra.c'; p.write_text(extra); sources.append(p)
        if overrides:
            facts = FACTS[PARTS[part][0]]['irq_names']
            names = list(CORE.values()) + [n+'_IRQHandler' for n in facts]
            p = self.dir/'overrides.c'
            p.write_text('volatile unsigned irq_probe;\n' + '\n'.join(
                f'void {name}(void) {{ irq_probe = {i+1}u; }}' for i,name in enumerate(names)))
            sources.append(p)
        objects = []
        for i,source in enumerate(sources):
            obj = self.dir/f'{i}.o'
            out = self.run_cmd([self.cc, *FLAGS, '-DBF_F4_COMPONENT_'+part.upper(), '-c', str(source), '-o', str(obj)])
            self.assertEqual(out.returncode, 0, out.stdout)
            objects.append(str(obj))
        elf = self.dir/(part+'.elf')
        args = [self.cc, *FLAGS, '-nostdlib', *objects, '-Wl,-L,'+str(LINK),
                '-Wl,-T,'+str(LINK/((linker or part)+'.ld')), '-Wl,--orphan-handling=error,--build-id=none', '-o', str(elf)]
        if gc:
            args.append('-Wl,--gc-sections')
        return self.run_cmd(args), elf

    def test_layout_vectors_and_weak_overrides(self):
        for part,(header,count,nvm,end) in PARTS.items():
            for overrides in (False, True):
                with self.subTest(part=part,overrides=overrides):
                    result,path = self.build(part,overrides=overrides,gc=True)
                    self.assertEqual(result.returncode,0,result.stdout)
                    with path.open('rb') as f:
                        elf=ELFFile(f); syms={s.name:int(s['st_value']) for s in elf.get_section_by_name('.symtab').iter_symbols()}
                        vec=elf.get_section_by_name('.isr_vector'); data=struct.unpack('<'+'I'*count,vec.data())
                        self.assertEqual(vec['sh_addr'],0x08000000)
                        self.assertEqual(data[0],0x20020000)
                        self.assertEqual(data[1],syms['Reset_Handler'])
                        self.assertTrue(data[1]&1)
                        for i,name in CORE.items():self.assertEqual(data[i],syms[name])
                        for i in (7,8,9,10,13):self.assertEqual(data[i],0)
                        for name,index in FACTS[header]['irq_names'].items():
                            self.assertEqual(data[index+16],syms[name+'_IRQHandler'],name)
                            self.assertTrue(data[index+16]&1,name)
                        for i in FACTS[header]['holes']:self.assertEqual(data[i+16],0)
                        self.assertEqual(syms['__bf_nvm_a'],nvm)
                        self.assertEqual(syms['__bf_nvm_b'],nvm+0x20000)
                        self.assertEqual(syms['__bf_flash_end'],end)
                        self.assertLessEqual(syms['_ram_used_end']+8192,syms['_estack'])
                        for section in elf.iter_sections():
                            if section['sh_flags']&2 and section['sh_size']:
                                a,z=section['sh_addr'],section['sh_size']
                                self.assertTrue(0x08000000<=a<a+z<=nvm or 0x20000000<=a<a+z<=0x20020000,section.name)
                        for seg in elf.iter_segments():
                            if seg['p_type']=='PT_LOAD' and seg['p_filesz']:
                                self.assertTrue(0x08000000<=seg['p_paddr']<seg['p_paddr']+seg['p_filesz']<=nvm)
                        for name in ('.bss','.dma_bss','.noinit'):
                            self.assertEqual(elf.get_section_by_name(name)['sh_type'],'SHT_NOBITS')

    def test_reset_execution(self):
        for part in PARTS:
            with self.subTest(part=part):
                result,path=self.build(part)
                self.assertEqual(result.returncode,0,result.stdout)
                verify(path)

    def test_part_guards(self):
        for defs in ([],['-DBF_F4_COMPONENT_F405XG','-DBF_F4_COMPONENT_F411XE']):
            p=self.run_cmd([self.cc,*FLAGS,*defs,'-c',str(START),'-o',str(self.dir/'bad.o')])
            self.assertNotEqual(p.returncode,0)
            self.assertIn('Select exactly one verified',p.stdout)
        for part,other in [('f405xg','f411xe'),('f411xe','f405xg')]:
            p,_=self.build(part,linker=other)
            self.assertNotEqual(p.returncode,0)
            self.assertIn('startup/linker part mismatch',p.stdout)

    def test_flash_and_ram_overflow(self):
        for part,(_,_,nvm,_) in PARTS.items():
            with self.subTest(part=part):
                size=nvm-0x08000000+4096
                p,_=self.build(part,extra=f'const unsigned char oversized_flash[{size}] = {{1}};')
                self.assertNotEqual(p.returncode,0);self.assertIn('FLASH',p.stdout)
                p,_=self.build(part,extra='volatile unsigned char oversized_ram[131072];')
                self.assertNotEqual(p.returncode,0);self.assertIn('RAM',p.stdout)
                p,_=self.build(part,extra='volatile unsigned char crowded_ram[122880];')
                self.assertNotEqual(p.returncode,0);self.assertIn('8 KiB stack headroom',p.stdout)

    def test_ccm_and_dma_placement(self):
        source='volatile unsigned ccm_scratch __attribute__((section(".ccm_noinit")));'
        p,path=self.build('f405xg',extra=source)
        self.assertEqual(p.returncode,0,p.stdout)
        with path.open('rb') as f:
            elf=ELFFile(f);sec=elf.get_section_by_name('.ccm_noinit')
            self.assertEqual(sec['sh_addr'],0x10000000);self.assertEqual(sec['sh_type'],'SHT_NOBITS')
            dma=elf.get_section_by_name('.dma_bss');self.assertGreaterEqual(dma['sh_addr'],0x20000000)
            self.assertLess(dma['sh_addr'],0x20020000);self.assertEqual(dma['sh_addr']%32,0)
        verify(path)
        p,_=self.build('f405xg',extra='volatile unsigned char ccm_overflow[65540] __attribute__((section(".ccm_noinit")));')
        self.assertNotEqual(p.returncode,0);self.assertIn('CCM',p.stdout)
        p,_=self.build('f411xe',extra=source)
        self.assertNotEqual(p.returncode,0);self.assertIn('CCM',p.stdout)

    def test_unexpected_allocated_sections_rejected(self):
        for part in PARTS:
            p,_=self.build(part,extra='const unsigned orphan __attribute__((section(".unmapped_component_data"))) = 42;')
            self.assertNotEqual(p.returncode,0);self.assertIn('unplaced orphan',p.stdout)

if __name__=='__main__':
    unittest.main(verbosity=2)
