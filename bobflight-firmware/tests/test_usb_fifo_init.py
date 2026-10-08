# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Real compiled stack with a bounded readiness-bit model, not USB emulation."""
import struct
import subprocess
import unittest
from unicorn import UC_HOOK_MEM_READ
import test_f405_usb_link as link
from test_f405_timebase import CYC,MASK

BASE=0x50000000
OTGINT,AHB,USB,RESET,GINTSTS,GINTMSK=BASE+4,BASE+8,BASE+12,BASE+16,BASE+20,BASE+24
GCCFG,GUID,ID,HW2,PCGC=BASE+0x38,BASE+0x3c,BASE+0x40,BASE+0x48,BASE+0xe00
AHBIDLE=1<<31

class ReadyBits(link.IRQMachine):
    def __init__(self,path,failure=None,clear_after=2):
        # Synthetic controller ID/readiness, not readings from Robert's board.
        self.usb={OTGINT:0,AHB:1,USB:0,RESET:AHBIDLE,GINTSTS:0,GINTMSK:0x1234,
                  GCCFG:0,GUID:0x1200,ID:0x4f54280a,HW2:0,PCGC:15}
        self.failure=failure;self.clear_after=clear_after;self.pending=None;self.polls=0
        self.commands=[];self.usb_accesses=[]
        super().__init__(path)
        self.reg[0xe000edf0]=0 # DHCSR: no debugger attached; TU_ASSERT may read it.
        self.uc.mem_map(BASE,0x1000)
        self.uc.hook_add(UC_HOOK_MEM_READ,self.read,begin=BASE,end=BASE+0xfff)
        assert self.call('fixture_usb_time_bind',mask=1)==1
        self.running_usb_time=True
    def read(self,uc,access,address,size,value,user):
        if address==CYC and getattr(self,'running_usb_time',False):self.cycles=(self.cycles+1680000)&MASK
        if not BASE<=address<BASE+0x1000:return super().read(uc,access,address,size,value,user)
        assert address in self.usb and size==4,('unmodeled USB read',hex(address),size)
        if address==RESET and self.pending:
            self.polls+=1
            kind,bit=self.pending
            if kind!=self.failure and self.polls>=self.clear_after:
                self.usb[RESET]&=~bit;self.pending=None
        self.usb_accesses.append(('read',address,self.usb[address]))
        uc.mem_write(address,struct.pack('<I',self.usb[address]))
    def write(self,uc,access,address,size,value,user):
        if not BASE<=address<BASE+0x1000:return super().write(uc,access,address,size,value,user)
        assert address in self.usb and size==4,('unmodeled USB write',hex(address),size)
        self.usb_accesses.append(('write',address,value))
        if address==RESET:
            self.usb[address]=value|AHBIDLE;self.polls=0
            kind,bit=('reset',1) if value&1 else ('tx',32) if value&32 else ('rx',16)
            self.pending=(kind,bit);self.commands.append((kind,value))
        elif address in (OTGINT,GINTSTS):self.usb[address]&=~value
        else:self.usb[address]=value

DCFG,DCTL=BASE+0x800,BASE+0x804
class DeviceModeBits(ReadyBits):
    def __init__(self,path,stuck=False,delay_fault=False):
        self.stuck=stuck;self.delay_fault=delay_fault;self.sequence=[]
        super().__init__(path)
        self.usb.update({DCFG:0,DCTL:0});self.usb[GINTSTS]=1
    def write(self,uc,access,address,size,value,user):
        oldmode=self.usb[GINTSTS]&1
        super().write(uc,access,address,size,value,user)
        if address==GINTSTS:self.usb[GINTSTS]|=oldmode # CMOD is read-only, not W1C.
        if address==USB and value&(1<<30):
            self.sequence.append(('force',self.cycles))
            if not self.stuck:self.usb[GINTSTS]&=~1
            if self.delay_fault:self.reg[0xe000e010]=5
        if address==DCTL:self.sequence.append(('disconnect' if value&2 else 'connect',self.cycles))
        if address==DCFG:self.sequence.append(('configure',self.cycles))

class USBFifoInit(link.F405USBLink):
    EXTRA_SOURCES=[link.ROOT/'tests/fixtures/usb_fifo_init/entry.c']
    EXTRA_DEFS=['-DDWC2_BF_FIFO_SPIN_MAX=8u',
                '-DCFG_TUSB_RHPORT0_MODE=(OPT_MODE_DEVICE|OPT_MODE_FULL_SPEED)']

    def test_device_mode_settle_disconnect_and_software_init(self):
        m=DeviceModeBits(self.images['f405'])
        self.assertEqual(m.call('fixture_tusb_start',mask=1),1)
        self.assertEqual([x[0] for x in m.sequence],['force','disconnect','configure','connect'])
        times=dict(m.sequence)
        self.assertGreaterEqual(((times['disconnect']-times['force'])&MASK)//168,50000)
        self.assertGreaterEqual(((times['configure']-times['disconnect'])&MASK)//168,20000)
        self.assertEqual(m.call('tud_inited'),1)
        self.assertEqual(m.call('tud_mounted'),0) # No host or enumeration in this model.
        self.assertEqual(m.nvic_writes,[(0xe000e108,8)])
        self.assertEqual(m.usb[DCTL]&2,0)

    def test_mode_or_delay_failure_never_reaches_device_bank(self):
        for stuck,delay_fault in ((True,False),(False,True)):
            with self.subTest(stuck=stuck,delay_fault=delay_fault):
                m=DeviceModeBits(self.images['f405'],stuck,delay_fault)
                self.assertEqual(m.call('fixture_tusb_start',mask=1),0)
                self.assertEqual([x[0] for x in m.sequence],['force'])
                self.assertEqual(m.call('tud_inited'),0)
                self.assertEqual(m.nvic_writes,[])
                self.assertFalse(any(a in (DCFG,DCTL) for op,a,v in m.usb_accesses))

    def test_default_and_invalid_compile_time_budgets(self):
        source=self.EXTRA_SOURCES[0]
        defs=[d for d in self.defs if not d.startswith('-DDWC2_BF_FIFO_SPIN_MAX=')]
        self.run_cmd([self.cc,*link.FLAGS,*self.includes,*defs,'-DBF_EXPECTED_FIFO_BUDGET=1000000u','-fsyntax-only',str(source)])
        for value in ('0','1000001'):
            p=subprocess.run([self.cc,*link.FLAGS,*self.includes,*defs,'-DDWC2_BF_FIFO_SPIN_MAX='+value,'-fsyntax-only',str(source)],capture_output=True,text=True,timeout=30)
            self.assertNotEqual(p.returncode,0)
            self.assertIn('#error',p.stderr)

    def test_fifo_last_allowed_poll_and_timeout(self):
        for kind in ('tx','rx'):
            for clear_after,expected in ((1,1),(8,1),(9,0)):
                with self.subTest(kind=kind,clear_after=clear_after):
                    m=ReadyBits(self.images['f405'],clear_after=clear_after)
                    self.assertEqual(m.call('fixture_fifo_budget'),8)
                    self.assertEqual(m.call('fixture_flush_'+kind,mask=1),expected)
                    self.assertEqual(m.polls,min(clear_after,8))
                    self.assertEqual(m.commands,[(kind,0x420 if kind=='tx' else 0x10)])
            m=ReadyBits(self.images['f405'],failure=kind)
            self.assertEqual(m.call('fixture_flush_'+kind,mask=1),0)
            self.assertEqual(m.polls,8)

    def test_common_core_success_requires_both_flushes(self):
        m=ReadyBits(self.images['f405'])
        self.assertEqual(m.call('fixture_core_start',mask=1),1)
        self.assertEqual([k for k,v in m.commands],['reset','tx','rx'])
        self.assertEqual(m.usb[AHB]&1,0)
        self.assertEqual(m.usb[GINTMSK],16)
        self.assertEqual(m.nvic_writes,[])

    def test_failure_propagates_through_actual_stack(self):
        for kind in ('tx','rx'):
            for layer in ('core','dcd','tud','tusb','legacy'):
                with self.subTest(kind=kind,layer=layer):
                    m=ReadyBits(self.images['f405'],failure=kind)
                    if layer=='legacy':m.uc.mem_write(m.sym['_tusb_rhport_role'][0],struct.pack('<I',1))
                    self.assertEqual(m.call('fixture_'+layer+'_start',mask=1),0)
                    self.assertEqual([k for k,v in m.commands],['reset','tx'] if kind=='tx' else ['reset','tx','rx'])
                    self.assertEqual(m.polls,8)
                    self.assertEqual(m.usb[AHB]&1,0)
                    self.assertEqual(m.usb[GINTMSK],0x1234)
                    self.assertEqual(m.nvic_writes,[])
                    if layer in ('tud','tusb','legacy'):
                        self.assertEqual(m.call('tud_inited'),0)
                        self.assertEqual(m.call('tusb_inited'),0)
                        self.assertEqual(m.value('_tusb_rhport_role'),0)
                        count=len(m.usb_accesses)
                        self.assertEqual(m.call('fixture_'+layer+'_start',mask=1),0)
                        self.assertEqual(m.call('tud_deinit',0,mask=1),0)
                        self.assertEqual(m.call('tud_inited'),0)
                        self.assertEqual(len(m.usb_accesses),count)

if __name__=='__main__':unittest.main(verbosity=2)
