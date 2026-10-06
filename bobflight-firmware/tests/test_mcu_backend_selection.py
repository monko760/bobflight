#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build selection/interface checks only; no MCU or flight qualification."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CMAKE = sys.argv.pop(1) if len(sys.argv) > 1 else 'cmake'
CC = sys.argv.pop(1) if len(sys.argv) > 1 else 'cc'
SOURCES = ['hal_f7_priv.c', 'hal_clock.c', 'hal_gpio.c', 'hal_spi.c',
           'sd_spi_hw.c', 'hal_adc.c', 'hal_uart.c', 'hal_tim_dma.c',
           'hal_tim_ic.c', 'hal_exti.c', 'hal_usb_cdc.c', 'hal_flash.c',
           'hal_bootloader.c', 'startup_stm32f722.c']
FIELDS = ['BF_BACKEND_FAMILY', 'BF_BACKEND_MCU', 'BF_USB_MCU',
          'BF_HAL_INCLUDE_DIRS', 'BF_LINKER_SCRIPT', 'BF_HAL_SOURCES']

class BackendSelection(unittest.TestCase):
    def probe(self, part, module='select_mcu_backend.cmake'):
        with tempfile.TemporaryDirectory() as temp:
            script = Path(temp)/'probe.cmake'
            script.write_text('include("'+(ROOT/'cmake'/module).as_posix()+'")\n'+
                              ''.join('message("PROBE_'+f+'=${'+f+'}")\n' for f in FIELDS))
            return subprocess.run([CMAKE, '-DBOBFLIGHT_TARGET_MCU='+part, '-P', str(script)],
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def test_exact_existing_parts_and_source_order(self):
        for part in ('STM32F722', 'STM32F745'):
            with self.subTest(part=part):
                result = self.probe(part)
                self.assertEqual(result.returncode, 0, result.stdout)
                fields = dict(line[6:].split('=', 1) for line in result.stdout.splitlines() if line.startswith('PROBE_'))
                self.assertEqual(fields['BF_BACKEND_FAMILY'], 'F7')
                self.assertEqual(fields['BF_BACKEND_MCU'], part)
                self.assertEqual(fields['BF_USB_MCU'], 'OPT_MCU_STM32F7')
                self.assertEqual(fields['BF_LINKER_SCRIPT'], (ROOT/'cmake'/(part.lower()+'.ld')).as_posix())
                self.assertEqual(fields['BF_HAL_INCLUDE_DIRS'], (ROOT/'src/hal/stm32f7').as_posix())
                self.assertEqual(fields['BF_HAL_SOURCES'].split(';'), ['src/hal/stm32f7/'+p for p in SOURCES])
                self.assertTrue(all((ROOT/p).is_file() for p in fields['BF_HAL_SOURCES'].split(';')))

    def test_implemented_registry_entries_have_matching_backend(self):
        for path in (ROOT/'targets/mcus').glob('*.json'):
            mcu = json.loads(path.read_text())
            if mcu['status'] == 'implemented':
                with self.subTest(part=mcu['part']):
                    result = self.probe(mcu['part'])
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertIn('PROBE_BF_BACKEND_FAMILY='+mcu['family'], result.stdout)

    def test_planned_unknown_and_ambiguous_parts_rejected(self):
        for part in ('', 'STM32F405', 'STM32F411', 'STM32H743', 'STM32F767',
                     'STM32F999', 'stm32f722', 'STM32F722;STM32F745'):
            with self.subTest(part=part):
                result = self.probe(part)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('MCU', result.stdout)

    def test_family_module_cannot_silently_default(self):
        self.assertNotEqual(self.probe('STM32F405', 'backends/stm32f7.cmake').returncode, 0)

    def test_shared_sources_do_not_import_family_headers(self):
        for path in (ROOT/'src').rglob('*'):
            if path.suffix in ('.c', '.h') and 'hal' not in path.relative_to(ROOT/'src').parts:
                self.assertNotRegex(path.read_text(), r'#\s*include\s*["<]hal/stm32(?:f4|f7|h7)/', str(path))

    def test_common_and_legacy_header_compatibility(self):
        includes = ['hal/boot_crumb.h', 'hal/stm32f7/boot_crumb.h',
                    'hal/sd_spi_hw.h', 'hal/stm32f7/sd_spi_hw.h']
        for names in (includes, list(reversed(includes))):
            with tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'headers.c'
                path.write_text('#define BOBFLIGHT_BOOT_LED_DIAGNOSTICS 1\n'+
                    ''.join('#include "'+name+'"\n' for name in names)+
                    '_Static_assert(BOOT_CRUMB_POST_USB == 7, "stage ABI");\n'
                    'void probe(void) { void (*a)(void)=hal_boot_diagnostic_pulse; '
                    'void (*b)(void)=boot_pa2_crude_short_pulse; '
                    'bool (*c)(sd_spi_io_t*)=sd_spi_hw_bind; '
                    'void (*d)(void)=sd_spi_hw_cancel; (void)a;(void)b;(void)c;(void)d; }\n')
                result = subprocess.run([CC, '-std=c11', '-Werror', '-fsyntax-only', '-I', str(ROOT/'src'), str(path)],
                                        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                self.assertEqual(result.returncode, 0, result.stdout)

if __name__ == '__main__':
    unittest.main(verbosity=2)
