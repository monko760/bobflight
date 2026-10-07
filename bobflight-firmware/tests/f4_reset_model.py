# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Bounded Cortex-M4 reset execution check. Not hardware qualification."""
import struct
import sys
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_PC, UC_ARM_REG_PRIMASK, UC_CPU_ARM_CORTEX_M4


def verify(path):
    with Path(path).open('rb') as stream:
        elf = ELFFile(stream)
        symbols = {s.name: int(s['st_value']) for s in elf.get_section_by_name('.symtab').iter_symbols()}
        uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
        uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
        uc.mem_map(0x08000000, 0x100000)
        uc.mem_map(0x20000000, 0x20000)
        uc.mem_map(0x10000000, 0x10000)
        uc.mem_map(0xE000E000, 0x1000)
        uc.mem_write(0x20000000, b'\xa5' * 0x20000)
        uc.mem_write(0x10000000, b'\xc3' * 0x10000)
        # Load physical ROM contents only. Copying .data directly to VMA would mask a broken reset.
        for seg in elf.iter_segments():
            if seg['p_type'] == 'PT_LOAD' and seg['p_filesz']:
                addr = int(seg['p_paddr'])
                assert 0x08000000 <= addr < 0x08100000, ('unexpected load image', hex(addr))
                uc.mem_write(addr, seg.data())
        vectors = elf.get_section_by_name('.isr_vector')
        assert vectors is not None
        msp, reset = struct.unpack('<II', vectors.data()[:8])
        assert reset & 1 and msp == 0x20020000
        uc.reg_write(UC_ARM_REG_SP, msp)
        entry = symbols['bf_f4_component_entry'] & ~1
        reached = []
        def stop_at_entry(cpu, address, size, user_data):
            if address == entry:
                reached.append(address)
                cpu.emu_stop()
        writes = []
        def check_write(cpu, access, address, size, value, user_data):
            writes.append(address)
            assert 0x20000000 <= address < 0x20020000 or address in (0xE000ED88, 0xE000ED08), ("unexpected reset write", hex(address))
        uc.hook_add(UC_HOOK_MEM_WRITE, check_write)
        uc.hook_add(UC_HOOK_CODE, stop_at_entry)
        uc.emu_start(reset, 0, count=20000)
        assert reached, ('component entry not reached within budget', hex(uc.reg_read(UC_ARM_REG_PC)))
        assert uc.reg_read(UC_ARM_REG_PRIMASK) == 1, "entry must retain interrupt mask"
        assert [a for a in writes if a >= 0xE0000000] == [0xE000ED88, 0xE000ED08]
        checked = []
        for sec in elf.iter_sections():
            size, addr = int(sec['sh_size']), int(sec['sh_addr'])
            if not size or not (int(sec['sh_flags']) & 2):
                continue
            if not (0x20000000 <= addr < 0x20020000):
                continue
            if sec.name.startswith('.data'):
                assert bytes(uc.mem_read(addr, size)) == sec.data(), ('data copy failed', sec.name)
                checked.append(sec.name)
            elif sec.name.startswith(('.bss', '.dma_bss')):
                assert bytes(uc.mem_read(addr, size)) == bytes(size), ('BSS not zeroed', sec.name)
                checked.append(sec.name)
            elif sec.name.startswith('.noinit'):
                assert bytes(uc.mem_read(addr, size)) == b'\xa5' * size, ('noinit overwritten', sec.name)
                checked.append(sec.name)
        assert all(any(n.startswith(prefix) for n in checked) for prefix in ('.data', '.bss', '.noinit')), checked
        ccm = elf.get_section_by_name('.ccm_noinit')
        if ccm is not None and ccm['sh_size']:
            assert bytes(uc.mem_read(ccm['sh_addr'], ccm['sh_size'])) == b'\xc3' * ccm['sh_size'], "CCM scratch overwritten"
        cpacr = struct.unpack('<I', bytes(uc.mem_read(0xE000ED88, 4)))[0]
        vtor = struct.unpack('<I', bytes(uc.mem_read(0xE000ED08, 4)))[0]
        assert cpacr & 0x00F00000 == 0x00F00000, hex(cpacr)
        assert vtor == vectors['sh_addr'], hex(vtor)
        print('PASS reset emulation:', path, 'data copied; bss zeroed; noinit preserved; CPACR/VTOR set; entry reached')


if __name__ == '__main__':
    assert len(sys.argv) > 1, 'Provide component-test ELF paths, never run against hardware.'
    for arg in sys.argv[1:]:
        verify(arg)
