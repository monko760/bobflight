# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Real reset/clock/time prefix and USB platform preparation, not enumeration."""
import struct
import subprocess
import unittest
from unicorn import UC_HOOK_MEM_READ
from unicorn.arm_const import UC_ARM_REG_PRIMASK
import test_f405_usb_link as link
from test_f405_clock_mmio import CR,PLL,CFGR

AHB1,AHB2,RESET=0x40023830,0x40023834,0x40023814
MODER,OTYPE,SPEED,PUPD,AFRH=0x40020000,0x40020004,0x40020008,0x4002000c,0x40020024
ISER,ICER,ICPR,IPR=0xe000e108,0xe000e188,0xe000e288,0xe000e443
PINMASK=(3<<22)|(3<<24);PA9MASK=3<<18

class PlatformMachine(link.IRQMachine):
    def __init__(self,path):
        self.platform={AHB1:0x00200002,AHB2:1,RESET:1,MODER:0x55555555,
                       OTYPE:0xffff,SPEED:0x55555555,PUPD:0x55555555,AFRH:0x12345678,
                       ISER:1<<7,ICER:0,ICPR:0,IPR:0xa0}
        self.initial=dict(self.platform);self.accesses=[];self.reject=None
        super().__init__(path)
        self.uc.mem_map(0x40020000,0x1000)
        self.uc.hook_add(UC_HOOK_MEM_READ,self.read,begin=0x40020000,end=0x40020fff)
    def read(self,uc,access,address,size,value,user):
        if address not in self.platform:return super().read(uc,access,address,size,value,user)
        assert size==(1 if address==IPR else 4)
        assert uc.reg_read(UC_ARM_REG_PRIMASK)&1
        if MODER<=address<=AFRH:assert self.platform[AHB1]&1
        assert address not in (ICER,ICPR), 'do not read W1C command registers as ordinary storage'
        self.accesses.append(('read',address,self.platform[address]))
        uc.mem_write(address,struct.pack('<B' if size==1 else '<I',self.platform[address]))
    def write(self,uc,access,address,size,value,user):
        if address not in self.platform:return super().write(uc,access,address,size,value,user)
        assert size==(1 if address==IPR else 4)
        assert uc.reg_read(UC_ARM_REG_PRIMASK)&1
        if MODER<=address<=AFRH:assert self.platform[AHB1]&1
        if address==RESET:assert self.platform[AHB2]&0x80
        assert address!=ISER, 'preparation must never enable USB interrupts'
        self.accesses.append(('write',address,value))
        if address==self.reject or (self.reject=='reset_release' and address==RESET and not value&0x80):return
        if address==ICER:self.platform[ISER]&=~value
        elif address!=ICPR:self.platform[address]=value
    def platform_writes(self):return [(a,v) for op,a,v in self.accesses if op=='write']

class USBPrepare(link.F405USBLink):
    EXTRA_SOURCES=[link.HAL/'usb_prepare.c',link.ROOT/'tests/fixtures/f405_usb_prepare/entry.c']

    def test_prepare_both_explicit_vbus_policies(self):
        for policy in (1,2):
            with self.subTest(policy=policy):
                m=PlatformMachine(self.images['f405']);p0=m.initial
                self.assertEqual(m.call('fixture_prepare',policy,mask=1),0)
                self.assertEqual(m.platform[AHB1],p0[AHB1]|1)
                self.assertEqual(m.platform[AHB2],p0[AHB2]|0x80)
                self.assertEqual(m.platform[RESET],p0[RESET])
                modes=(p0[MODER]&~PINMASK)|(2<<22)|(2<<24)
                pulls=p0[PUPD]&~PINMASK
                if policy==2:modes&=~PA9MASK;pulls&=~PA9MASK
                self.assertEqual(m.platform[MODER],modes)
                self.assertEqual(m.platform[PUPD],pulls)
                self.assertEqual(m.platform[SPEED],p0[SPEED]|PINMASK)
                self.assertEqual(m.platform[OTYPE],p0[OTYPE]&~((1<<11)|(1<<12)))
                self.assertEqual(m.platform[AFRH],(p0[AFRH]&~0xff000)|0xaa000)
                self.assertEqual(m.platform[IPR],0x50)
                self.assertEqual(m.platform[ISER],p0[ISER])
                self.assertEqual([v for a,v in m.platform_writes() if a==RESET],[p0[RESET]|0x80,p0[RESET]])
                self.assertIn((ICER,8),m.platform_writes());self.assertIn((ICPR,8),m.platform_writes())
                # USB core/PHY registers remain unmapped throughout this test.
                count=len(m.platform_writes());self.assertEqual(m.call('fixture_prepare',policy,mask=1),7)
                self.assertEqual(len(m.platform_writes()),count)

    def test_prepare_invalid_metadata_and_context_without_configuration_writes(self):
        for mode in ('null','zero_vbus','bad_vbus','bad_hclk','unmasked','handler'):
            with self.subTest(mode=mode):
                m=PlatformMachine(self.images['f405']);kwargs={'mask':1};fn='fixture_prepare';policy=1;expect=1
                if mode=='null':fn='fixture_prepare_null'
                if mode=='zero_vbus':policy=0
                if mode=='bad_vbus':policy=3
                if mode=='bad_hclk':m.uc.mem_write(m.sym['fixture_clocks'][0]+8,struct.pack('<I',16000000))
                if mode=='unmasked':kwargs={'mask':0};expect=2
                if mode=='handler':kwargs['ipsr']=15;expect=2
                self.assertEqual(m.call(fn,policy,**kwargs),expect)
                self.assertEqual(m.accesses,[])

    def test_prepare_clock_register_mismatch_rejected(self):
        for address,bit in ((PLL,1<<24),(CFGR,1<<10),(CR,1<<18)):
            with self.subTest(address=hex(address)):
                m=PlatformMachine(self.images['f405']);m.clock.reg[address]^=bit
                self.assertEqual(m.call('fixture_prepare',1,mask=1),3)
                self.assertEqual(m.platform_writes(),[])

    def test_prepare_owned_usb_or_unhealthy_time_rejected(self):
        for reg,bit in ((AHB2,0x80),(RESET,0x80),(ISER,8)):
            m=PlatformMachine(self.images['f405']);m.platform[reg]|=bit
            self.assertEqual(m.call('fixture_prepare',1,mask=1),4);self.assertEqual(m.platform_writes(),[])
        m=PlatformMachine(self.images['f405']);m.reg[0xe000e010]=5
        self.assertEqual(m.call('fixture_prepare',1,mask=1),5);self.assertEqual(m.platform_writes(),[])

    def test_prepare_rejected_writes_latch_until_reset(self):
        for rejected in (AHB1,AFRH,OTYPE,SPEED,PUPD,MODER,AHB2,RESET,'reset_release',IPR):
            with self.subTest(rejected=rejected):
                m=PlatformMachine(self.images['f405']);m.reject=rejected
                self.assertEqual(m.call('fixture_prepare',1,mask=1),6)
                count=len(m.platform_writes());m.reject=None
                self.assertEqual(m.call('fixture_prepare',1,mask=1),7)
                self.assertEqual(len(m.platform_writes()),count)

    def test_prepare_compile_part_guards(self):
        for defs in ([],['-DBF_F4_COMPONENT_F411XE'],['-DBF_F4_COMPONENT_F405XG','-DBF_F4_COMPONENT_F411XE']):
            p=subprocess.run([self.cc,*link.FLAGS,'-I'+str(link.ROOT/'src'),*defs,'-c',str(link.HAL/'usb_prepare.c'),'-o',str(self.dir/'bad-prepare.o')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
            self.assertNotEqual(p.returncode,0,p.stdout)

    def test_f405_controller_init_omits_reserved_session_overrides(self):
        # Compile-time branch check, NOT controller execution or enumeration.
        for family in ('f405','f7'):
            inc=self.includes if family=='f405' else ['-I'+str(link.ROOT/'src/hal/stm32f7'),*[p for p in self.includes if p!='-I'+str(link.HAL)]]
            defs=self.defs if family=='f405' else ['-DCFG_TUSB_MCU=OPT_MCU_STM32F7']
            text=self.run_cmd([self.cc,*link.FLAGS,*inc,*defs,'-E','-P',str(link.TUSB/'portable/synopsys/dwc2/dcd_dwc2.c')])
            body=text.rsplit('dcd_init(',1)[1].split('dcd_deinit(',1)[0]
            self.assertIn('dwc2_stm32_gccfg_cfg',body)
            if family=='f405':self.assertNotIn('gotgctl',body)
            else:self.assertIn('gotgctl',body)

if __name__=='__main__':unittest.main(verbosity=2)
