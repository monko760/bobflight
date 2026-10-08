# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Standalone image link/identity/IRQ audit and native read-only parser checks."""
import importlib.util
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from elftools.elf.elffile import ELFFile
ROOT=Path(__file__).resolve().parents[1]
class Diagnostic(unittest.TestCase):
    def test_complete_image_and_irq_unmask(self):
        spec=importlib.util.spec_from_file_location('diag_builder',ROOT/'tools/build_f405_usb_diagnostic.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            image=module.build(Path(tmp))
            with image.open('rb') as f:
                e=ELFFile(f);symbols={s.name:int(s['st_value']) for s in e.get_section_by_name('.symtab').iter_symbols()}
                for n in ('Reset_Handler','SysTick_Handler','OTG_FS_IRQHandler','bf_f4_component_entry','g_f405_diag','tusb_rhport_init'):
                    self.assertIn(n,symbols)
                for n in ('malloc','_sbrk','snprintf','hal_motor_write','loop_pid'):
                    self.assertNotIn(n,symbols)
                v=e.get_section_by_name('.isr_vector').data()
                self.assertEqual(struct.unpack_from('<I',v,15*4)[0],symbols['SysTick_Handler'])
                self.assertEqual(struct.unpack_from('<I',v,(16+67)*4)[0],symbols['OTG_FS_IRQHandler'])
                self.assertNotEqual(symbols['OTG_FS_IRQHandler'],symbols['Default_Handler'])
                for seg in e.iter_segments():
                    if seg['p_type']=='PT_LOAD' and seg['p_filesz']:
                        self.assertTrue(0x08000000<=seg['p_paddr']<seg['p_paddr']+seg['p_filesz']<=0x080c0000)
            data=image.with_suffix('.bin').read_bytes()
            self.assertIn(b'BobFlight F405 USB test',data)
            self.assertIn(b'Read-only commands: help, status, version',data)
            dump=subprocess.check_output(['arm-none-eabi-objdump','-d',str(image)],text=True)
            body=dump.split('<bf_f4_component_entry>:',1)[1].split('\n\n',1)[0]
            self.assertLess(body.index('<tusb_rhport_init>'),body.index('cpsie'))
            self.assertIn('wfi',body)
    def test_parser_rejects_writes_controls_and_overlong_prefixes(self):
        code=r'''
#include <assert.h>
#include "cli.h"
static diag_cmd_t feed(diag_cli_t *s,const char *p) {diag_cmd_t r=DIAG_NONE;while(*p){diag_cmd_t v=diag_cli_feed(s,(uint8_t)*p++);if(v!=DIAG_NONE)r=v;}return r;}
int main(void) {
 diag_cli_t s;diag_cli_reset(&s);
 assert(feed(&s,"help\r\n")==DIAG_HELP);assert(feed(&s,"status\n")==DIAG_STATUS);
 assert(feed(&s,"version\n")==DIAG_VERSION);assert(feed(&s,"save\n")==DIAG_BAD);
 assert(feed(&s,"bl\n")==DIAG_BAD);assert(feed(&s,"motor 1 1000\n")==DIAG_BAD);
 assert(feed(&s,"helpx\b\n")==DIAG_HELP);assert(feed(&s,"\n\n")==DIAG_NONE);
 feed(&s,"status");for(int i=0;i<400;i++)diag_cli_feed(&s,' ');
 assert(feed(&s,"\n")==DIAG_BAD);assert(feed(&s,"help\n")==DIAG_HELP);
 feed(&s,"help");diag_cli_feed(&s,0);assert(feed(&s,"\n")==DIAG_BAD);
 feed(&s,"sta");diag_cli_reset(&s);assert(feed(&s,"tus\n")==DIAG_BAD);
 return 0;
}
'''
        cc=shutil.which('cc') or shutil.which('gcc')
        self.assertIsNotNone(cc)
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'parser.c';source.write_text(code);binary=Path(tmp)/'parser'
            subprocess.run([cc,'-std=c11','-Wall','-Wextra','-Werror','-I'+str(ROOT/'diagnostics/f405_usb'),str(source),'-o',str(binary)],check=True,timeout=30)
            subprocess.run([str(binary)],check=True,timeout=10)
if __name__=='__main__':unittest.main(verbosity=2)
