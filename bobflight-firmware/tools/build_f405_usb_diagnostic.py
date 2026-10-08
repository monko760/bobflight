#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Build only. Never erase/flash. Experimental USB-only MLTEMPF4 reference image."""
import argparse
import shutil
import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FLAGS=['-std=c11','-Wall','-Wextra','-Werror','-ffreestanding','-fno-builtin',
       '-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=hard','-Os']
def build(out):
    out=Path(out).resolve();out.mkdir(parents=True,exist_ok=True)
    cc=shutil.which('arm-none-eabi-gcc');objcopy=shutil.which('arm-none-eabi-objcopy')
    if not cc or not objcopy:raise RuntimeError('ARM GCC and objcopy must be on PATH')
    hal=ROOT/'src/hal/stm32f4';usb=ROOT/'third_party/tinyusb/src'
    flags=FLAGS+['-DBF_F4_COMPONENT_F405XG','-DBF_F405_USB_DIAGNOSTIC=1','-DCFG_TUSB_MCU=OPT_MCU_STM32F4']
    flags+=['-I'+str(p) for p in (ROOT/'src',hal,usb,ROOT/'third_party/cmsis-core/Include')]
    sources=[hal/n for n in ('startup_component.c','clock_plan.c','clock_start.c','clock_mmio.c','timebase.c','usb_prepare.c','usb_time.c')]
    sources += [ROOT/'diagnostics/f405_usb/main.c',ROOT/'src/usb/usb_descriptors.c']
    sources += [usb/n for n in ('tusb.c','common/tusb_fifo.c','device/usbd.c','class/cdc/cdc_device.c','portable/synopsys/dwc2/dcd_dwc2.c','portable/synopsys/dwc2/dwc2_common.c')]
    objects=[]
    for i,source in enumerate(sources):
        obj=out/f'unit-{i}.o';subprocess.run([cc,*flags,'-c',str(source),'-o',str(obj)],check=True,timeout=60);objects.append(str(obj))
    elf=out/'bobflight-mltempf4-usb-diagnostic.elf'
    subprocess.run([cc,*FLAGS,'-nostdlib',*objects,'-Wl,-L,'+str(ROOT/'cmake/components'),
        '-Wl,-T,'+str(ROOT/'cmake/components/f405xg.ld'),
        '-Wl,--orphan-handling=error,--build-id=none,--strip-debug',
        '-Wl,--start-group','-lc','-lgcc','-Wl,--end-group','-o',str(elf)],check=True,timeout=60)
    for fmt,suffix in [('binary','.bin'),('ihex','.hex')]:
        subprocess.run([objcopy,'-O',fmt,str(elf),str(elf.with_suffix(suffix))],check=True,timeout=30)
    print('Built experimental USB-only diagnostic:',elf)
    print('Build only; nothing flashed. Experimental USB/CLI image, not flight firmware.')
    return elf
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',required=True,type=Path)
    build(p.parse_args().out)
