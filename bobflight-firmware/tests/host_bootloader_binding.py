#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Actual host CLI transcript plus source integration checks; NOT a ROM/USB test."""
import subprocess,sys
from pathlib import Path
exe,root=sys.argv[1],Path(sys.argv[2])
r=subprocess.run([exe],input='help\nBL\nbl discard\nbl extra\nreboot\n',text=True,capture_output=True,timeout=10)
assert r.returncode==0,r.stderr
assert 'bl / BL' in r.stdout
assert r.stdout.count('bl unavailable: unsupported board/MCU or invalid ROM vectors')==2,r.stdout
assert 'unknown' in r.stdout and 'reboot...' in r.stdout and 'host smoke: ok' in r.stdout
cli=(root/'src/drivers/cli.c').read_text()
assert cli.index('if (bl_pending) return;')<cli.index('if (cmd_bootloader(line)) return;')<cli.index('if (strcmp(line, "storage")')
assert 'bl_pending = bl_discard = false;' in cli
poll=cli[cli.index('void cli_poll(void)'):]
assert poll.index('hal_usb_cdc_poll();')<poll.index('bootloader_poll();')
assert poll.index('handle_line(g_line);')<poll.index('bootloader_poll();')
assert poll.index('if (bl_pending) {')<poll.index("if (c == '\\n'")
assert "g_discard_line = c != '\\n' && c != '\\r';" in poll
startup=(root/'src/hal/stm32f7/startup_stm32f722.c').read_text().split('void Reset_Handler(void)\n{',1)[1]
assert startup.index('hal_bootloader_early_check();')<startup.index('while (dst < &_edata)')
assert startup.index('hal_bootloader_early_check();')<startup.index('0xE000ED88')
hal=(root/'src/hal/stm32f7/hal_bootloader.c').read_text()
assert '.noinit' in hal and 'aligned(8)' in hal
assert '0x400030' not in hal and '0x5555' not in hal # no IWDG timeout manipulation
assert 'hal_bootloader.c' in (root/'CMakeLists.txt').read_text()
print('PASS actual host CLI unsupported/unknown/reboot transcript; pending-command fence, USB polling, early startup and no-watchdog-write source bindings')
