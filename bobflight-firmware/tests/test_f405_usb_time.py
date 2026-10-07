# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Execute owned USB timing callbacks and finite waits, without USB simulation."""
import struct
import unittest
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_LR,UC_ARM_REG_PRIMASK,UC_ARM_REG_PC
import test_f405_usb_link as link
from test_f405_timebase import CYC,MASK

class TimeMachine(link.IRQMachine):
    def read(self,uc,access,address,size,value,user):
        if address==CYC:self.cycles=(self.cycles+getattr(self,'step',0))&MASK
        return super().read(uc,access,address,size,value,user)
    def wait(self,delay,budget,mask=0,ipsr=0):
        self.uc.reg_write(UC_ARM_REG_R1,budget)
        return self.call('bf_f405_usb_wait_us',delay,mask=mask,ipsr=ipsr)

class USBTime(link.F405USBLink):
    def machine(self,bind=True):
        m=TimeMachine(self.images['f405'])
        if bind:self.assertEqual(m.call('fixture_usb_time_bind',mask=1),1)
        return m

    def test_binding_requires_valid_clocks_time_and_context(self):
        for mode in ('null','hclk','usb','unmasked','handler','time'):
            with self.subTest(mode=mode):
                m=self.machine(False);name='fixture_usb_time_bind';kwargs={'mask':1}
                m.uc.mem_write(m.sym['SystemCoreClock'][0],struct.pack('<I',123456))
                if mode=='null':name='fixture_usb_time_bind_null'
                if mode in ('hclk','usb'):
                    offset=8 if mode=='hclk' else 12
                    m.uc.mem_write(m.sym['fixture_clocks'][0]+offset,struct.pack('<I',16000000))
                if mode=='unmasked':kwargs={'mask':0}
                if mode=='handler':kwargs['ipsr']=15
                if mode=='time':m.reg[0xe000e010]=5
                self.assertEqual(m.call(name,**kwargs),0)
                self.assertEqual(m.value('SystemCoreClock'),123456)
        m=self.machine();m.advance(168000)
        self.assertEqual(m.call('fixture_usb_time_bind',mask=1),0)
        self.assertEqual(m.call('tusb_time_millis_api'),1)

    def test_wait_progress_wrap_and_irq_mask_preservation(self):
        for mask in (0,1):
            for wrap in (False,True):
                with self.subTest(mask=mask,wrap=wrap):
                    m=self.machine();m.step=16800
                    if wrap:m.cycles=MASK-100
                    self.assertEqual(m.wait(500,5,mask),1)
                    self.assertEqual(m.wait(0,1,mask),1)
                    m.step=168000
                    m.call('tusb_time_delay_ms_api',2,mask=mask)

    def test_wait_work_is_bounded_when_counter_stops(self):
        m=self.machine();m.reads.clear()
        self.assertEqual(m.wait(500,5),0)
        self.assertLessEqual(m.reads.count(CYC),6)
        m.step=16800;self.assertEqual(m.wait(500,4),0)
        self.assertEqual(m.wait(500,5),1)

    def test_wait_invalid_requests_and_unavailable_time(self):
        m=self.machine(False);self.assertEqual(m.wait(1,5),0)
        self.assertEqual(m.call('fixture_usb_time_bind',mask=1),1)
        for delay,budget in ((100001,1),(0,0),(1,1000001),(0xffffffff,1)):
            m.reads.clear();self.assertEqual(m.wait(delay,budget),0)
            self.assertEqual(m.reads.count(CYC),0)
        m.reads.clear();self.assertEqual(m.wait(1,5,ipsr=15),0)
        self.assertEqual(m.reads.count(CYC),0)
        m.reg[0xe000e010]=5;self.assertEqual(m.wait(1,5),0)

    def test_fault_callbacks_store_reason_and_stop(self):
        for name,arg,reason,bind,bad_time in (
            ('tusb_time_millis_api',0,1,False,False),
            ('tusb_time_delay_ms_api',101,2,True,False),
            ('tusb_time_delay_ms_api',1,3,True,True)):
            with self.subTest(name=name,reason=reason):
                m=self.machine(bind)
                if bad_time:m.reg[0xe000e010]=5
                m.uc.reg_write(UC_ARM_REG_R0,arg);m.uc.reg_write(UC_ARM_REG_LR,m.sym['fixture_return'][0]|1)
                m.uc.reg_write(UC_ARM_REG_PRIMASK,0);m.stops.clear()
                m.uc.emu_start(m.sym[name][0]|1,0,count=1000)
                self.assertEqual(m.stops,[])
                self.assertEqual(m.value('bf_f405_usb_time_fault_reason'),reason)
                self.assertEqual(m.uc.reg_read(UC_ARM_REG_PRIMASK),1)
                address,size=m.sym['bf_f405_usb_time_fault'];pc=m.uc.reg_read(UC_ARM_REG_PC)
                self.assertTrue((address&~1)<=pc<(address&~1)+size)

if __name__=='__main__':unittest.main(verbosity=2)
