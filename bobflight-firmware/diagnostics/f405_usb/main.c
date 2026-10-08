/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Standalone USB-only diagnostic, NOT the normal firmware/flight target.
 * Assumptions: MLTEMPF4 reference wiring, 8 MHz crystal, 3.3 V, F405xG.
 * GPIO access is PA11/12 only. Do not connect battery, ESC or other supplies.
 */
#include <stdint.h>
#include <stdbool.h>
#include "tusb.h"
#include "hal/stm32f4/clock_mmio.h"
#include "hal/stm32f4/timebase.h"
#include "hal/stm32f4/usb_prepare.h"
#include "hal/stm32f4/usb_time.h"
#include "cli.h"

/* SWD-readable if startup cannot reach CDC. BOOT pads provide recovery, not
 * access to these fields. Stage remains the failing stage; code is nonzero. */
volatile struct {
    uint32_t stage, error, chip_id, flash_kib, clock_status, prepare_status;
    uint32_t loops, commands, rx_bytes, tx_bytes;
} g_f405_diag;
static bf_f4_clock_plan_t clocks;
static diag_cli_t parser;
static char reply[512];
static uint32_t reply_len,reply_sent;
static bool session;

__attribute__((noreturn)) static void stop(uint32_t code)
{
    __asm volatile("cpsid i" ::: "memory");
    g_f405_diag.error=code;
    for(;;)__asm volatile("nop");
}
void bf_f405_usb_time_fault(uint32_t reason)
{
    bf_f405_usb_time_fault_reason=reason;
    stop(0x100u+reason);
}
void OTG_FS_IRQHandler(void) { tusb_int_handler(0,true); }

static void text(const char *s)
{
    while(*s && reply_len<sizeof(reply)-1u)reply[reply_len++]=*s++;
}
static void number(uint32_t n)
{
    char digits[10];unsigned i=0;
    do { digits[i++]=(char)('0'+n%10u);n/=10u; }while(n);
    while(i) { char ch[2]={digits[--i],0};text(ch); }
}
static void field(const char *name,uint32_t n) { text(name);number(n);text("\r\n"); }
static void respond(diag_cmd_t cmd)
{
    reply_len=reply_sent=0;
    if(cmd==DIAG_HELP)text("Read-only commands: help, status, version\r\nNo save, motors, sensors or bl command.\r\n");
    else if(cmd==DIAG_VERSION)text("BobFlight F405 USB diagnostic, MLTEMPF4 reference\r\nExperimental; not normal firmware or flight-qualified.\r\n");
    else if(cmd==DIAG_STATUS) {
        uint32_t ms=0;
        if(!bf_f405_time_read_ms(&ms))stop(9);
        field("stage=",g_f405_diag.stage);field("error=",g_f405_diag.error);
        field("chip_id_decimal=",g_f405_diag.chip_id);field("flash_kib=",g_f405_diag.flash_kib);
        field("hclk_hz_nominal=",clocks.hclk_hz);field("usb_hz_nominal=",clocks.usb_hz);
        field("uptime_ms=",ms);field("loops=",g_f405_diag.loops);
        field("commands=",g_f405_diag.commands);field("rx_bytes=",g_f405_diag.rx_bytes);
        field("tx_bytes=",g_f405_diag.tx_bytes);field("mounted=",tud_mounted()?1u:0u);
        text("USB-only; PA9 unchanged; no motor or flash-programming drivers.\r\n");
    } else text("Rejected. Read-only diagnostic: help, status, version only.\r\n");
    text("# ");
}
static void cli_poll(void)
{
    if(!tud_cdc_connected()) {
        session=false;diag_cli_reset(&parser);reply_len=reply_sent=0;
        if(tud_mounted())tud_cdc_read_flush();
        return;
    }
    if(!session) { session=true;respond(DIAG_VERSION); }
    if(reply_sent<reply_len) {
        uint32_t count=tud_cdc_write(reply+reply_sent,reply_len-reply_sent);
        if(count>reply_len-reply_sent)stop(10);
        reply_sent+=count;g_f405_diag.tx_bytes+=count;
        (void)tud_cdc_write_flush();
        return; /* Preserve unsent bytes; never spin waiting for host capacity. */
    }
    for(unsigned budget=0;budget<32 && tud_cdc_available();budget++) {
        uint8_t ch;
        if(tud_cdc_read(&ch,1)!=1)break;
        g_f405_diag.rx_bytes++;
        diag_cmd_t cmd=diag_cli_feed(&parser,ch);
        if(cmd!=DIAG_NONE) { g_f405_diag.commands++;respond(cmd);break; }
    }
}
void bf_f4_component_entry(void)
{
    /* Reset entry already masks IRQs, configures CPACR/VTOR and clears C state. */
    g_f405_diag.stage=1;
    g_f405_diag.chip_id=*(volatile const uint32_t *)0xe0042000u;
    g_f405_diag.flash_kib=*(volatile const uint16_t *)0x1fff7a22u;
    /* ID 0x413 is shared by F405/F407 variants: not an exact part probe. */
    if((g_f405_diag.chip_id&0xfffu)!=0x413u || g_f405_diag.flash_kib!=1024u)stop(1);
    g_f405_diag.stage=2;
    g_f405_diag.clock_status=bf_f405_clock_mmio_start(8000000u,3300u,1000000u,&clocks);
    if(g_f405_diag.clock_status!=BF_F4_CLOCK_START_OK)stop(2);
    g_f405_diag.stage=3;
    if(!bf_f405_time_init(clocks.hclk_hz))stop(3);
    g_f405_diag.stage=4;
    g_f405_diag.prepare_status=bf_f405_usb_prepare(&clocks,BF_F405_USB_VBUS_BUS_POWERED);
    if(g_f405_diag.prepare_status!=BF_F405_USB_PREPARE_OK)stop(4);
    g_f405_diag.stage=5;
    if(!bf_f405_usb_time_bind(&clocks))stop(5);
    const tud_configure_param_t cfg={.dwc2={.bm_double_buffered=0,.vbus_sensing=false}};
    const tusb_rhport_init_t rh={.role=TUSB_ROLE_DEVICE,.speed=TUSB_SPEED_FULL};
    g_f405_diag.stage=6;
    if(!tud_configure(0,TUD_CFGID_DWC2,&cfg))stop(6);
    g_f405_diag.stage=7;
    if(!tusb_init(0,&rh))stop(7);
    g_f405_diag.stage=8;
    /* TinyUSB enabled its NVIC line; only now allow IRQ delivery and SysTick. */
    __asm volatile("dsb sy\nisb sy\ncpsie i" ::: "memory");
    for(;;) {
        tud_task_ext(0,false);
        cli_poll();g_f405_diag.loops++;
        __asm volatile("wfi" ::: "memory");
    }
}
