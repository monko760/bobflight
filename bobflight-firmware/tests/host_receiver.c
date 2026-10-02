/* SPDX-License-Identifier: Apache-2.0 */
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/crsf.h"
#include "board/board.h"
#include "hal/hal.h"
#include <assert.h>
#include <math.h>
#include <string.h>
static uint32_t now, notes;
static uint8_t wire[1024];
static size_t used, limit=64;
static board_t board={.rx_uart=6,.rx_pin=HAL_PIN_PACK(2,7),.tx_pin=HAL_PIN_PACK(2,6)};
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
uint32_t hal_millis(void){return now;}
void failsafe_note_rx_frame(uint32_t t){assert(t==now);notes++;}
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *c){assert(c->baud==420000);return (hal_uart_t*)&board;}
size_t hal_uart_read(hal_uart_t *u,uint8_t *b,size_t n){
    (void)u;if(n>limit)n=limit;if(n>used)n=used;
    memcpy(b,wire,n);memmove(wire,wire+n,used-n);used-=n;return n;
}
static void frame_roll(uint8_t f[26],uint16_t roll){
    uint16_t values[16];for(unsigned i=0;i<16;i++)values[i]=992;
    values[0]=roll;values[1]=1811;values[2]=172;values[3]=992;values[15]=1811;
    memset(f,0,26);f[0]=0xc8;f[1]=24;f[2]=0x16;
    for(unsigned c=0;c<16;c++)for(unsigned b=0;b<11;b++)
        if(values[c]&(1u<<b))f[3+(c*11+b)/8]|=1u<<((c*11+b)%8);
    f[25]=crsf_crc8(f+2,23);
}
static void frame(uint8_t f[26]){frame_roll(f,172);}
static void feed(const uint8_t *p,size_t n){assert(n+used<=sizeof(wire));memcpy(wire+used,p,n);used+=n;}
/* CRSF LINK_STATISTICS 0x14: 10-byte payload, uplink LQ at payload byte 2. */
static void stats(uint8_t lq){
    uint8_t s[14]={0xc8,12,0x14,60,62,lq,9,0,7,3,70,98,5,0};s[13]=crsf_crc8(s+2,11);feed(s,14);
}
/* Advance `ms` in 5 ms polls (the CRSF stall guard drains after >10 ms idle),
 * feeding RC frame `f` every 10 ms when non-NULL. */
static void run_ms(unsigned ms,const uint8_t *f){
    for(unsigned t=0;t<ms;t+=5){now+=5;if(f&&t%10==0)feed(f,26);rx_poll();}
}
static void link_gate_checks(void){
    /* g: roll centred instead of full left, so a gated frame would be visible in channels. */
    uint8_t f[26],g[26];frame(f);frame_roll(g,992);
    now=100000;used=0;rx_init();
    assert(!rx_link_stats_present()&&rx_link_lq()==-1&&rx_loss_reason()==RX_LOSS_NO_FRAMES);
    assert(!strcmp(rx_loss_reason_name(rx_loss_reason()),"no-frames"));
    /* Absent stats: frames-only, exactly as before (5 s of frames stays fresh). */
    uint32_t n0=notes;run_ms(5000,f);
    assert(notes==n0+500&&rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE&&!rx_link_stats_present()&&rx_link_lq()==-1);
    /* An out-of-range LQ is not a stats frame. */
    stats(101);run_ms(10,f);assert(!rx_link_stats_present());
    stats(87);run_ms(10,f);assert(rx_link_stats_present()&&rx_link_lq()==87&&rx_loss_reason()==RX_LOSS_NONE);
    assert(!strcmp(rx_loss_reason_name(rx_loss_reason()),"none"));
    /* LQ 0: valid frames keep arriving but refresh nothing (channels, count, failsafe timer). */
    stats(0);rx_poll();
    uint32_t n1=notes,c1=rx_frame_count();assert(rx_channels()[0]==-1);
    run_ms(240,g);
    assert(notes==n1&&rx_frame_count()==c1&&rx_channels()[0]==-1);
    assert(rx_link_lq()==0&&rx_loss_reason()==RX_LOSS_LQ_ZERO&&!strcmp(rx_loss_reason_name(RX_LOSS_LQ_ZERO),"lq-zero"));
    run_ms(20,g);assert(!rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_LQ_ZERO); /* raw frames still seen */
    /* Recovery: LQ > 0 reopens the gate; the next frame is accepted. */
    stats(40);run_ms(10,g);assert(notes==n1+1&&rx_frame_fresh()&&rx_channels()[0]==0&&rx_loss_reason()==RX_LOSS_NONE);
    /* Stale: no stats for exactly 1000 ms is still fine; 1001+ ms closes the gate. */
    stats(40);rx_poll();uint32_t t_stats=now;
    while(now-t_stats<1000u){now+=5;if((now-t_stats)%10==0)feed(f,26);rx_poll();}
    assert(now-t_stats==1000u&&rx_loss_reason()==RX_LOSS_NONE&&rx_link_lq()==40);
    uint32_t n2=notes;feed(f,26);now+=1;rx_poll();
    assert(notes==n2&&rx_loss_reason()==RX_LOSS_STATS_STALE&&rx_link_lq()==-1&&rx_link_stats_present());
    assert(!strcmp(rx_loss_reason_name(RX_LOSS_STATS_STALE),"stats-stale"));
    run_ms(300,f);assert(notes==n2&&!rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_STATS_STALE);
    /* Everything stops: no-frames wins once raw frames are older than 250 ms. */
    run_ms(245,NULL);assert(rx_loss_reason()==RX_LOSS_STATS_STALE);run_ms(5,NULL);assert(rx_loss_reason()==RX_LOSS_NO_FRAMES);
    /* Receiver re-initialisation (map/UART change) forgets the stats: absent again. */
    rx_init();assert(!rx_link_stats_present()&&rx_link_lq()==-1);
    feed(f,26);rx_poll();assert(rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE);
}
int main(void){
    uint8_t f[26];frame(f);rx_init();
    assert(!rx_frame_fresh());assert(rx_frame_age_ms()==UINT32_MAX);assert(rx_channels()[4]==0);
    limit=1;feed(f,26);for(unsigned i=0;i<26;i++)rx_poll();
    assert(notes==1 && rx_frame_count()==1 && rx_frame_fresh());
    assert(rx_channels()[0]==-1 && rx_channels()[1]>.99 && rx_channels()[3]==0 && rx_channels()[15]>.99);
    now=250;assert(rx_frame_fresh());now=251;assert(!rx_frame_fresh());
    /* Old buffered data following a stalled scheduler must not refresh loss timer. */
    limit=64;feed(f,26);rx_poll();assert(notes==1);assert(crsf_stream_resets()==1);
    now++;feed(f,26);rx_poll();assert(notes==2 && rx_frame_fresh());
    f[25]^=1;feed(f,26);rx_poll();assert(notes==2 && crsf_crc_errors()>0);f[25]^=1;
    /* Interrupted frame then a complete packet resynchronizes after idle. */
    feed(f,8);rx_poll();now+=11;rx_poll();feed(f,26);rx_poll();assert(notes==3);
    /* Valid non-RC packets never count as receiver control input. */
    uint8_t other[4]={0xc8,2,0x14,0};other[3]=crsf_crc8(other+2,1);
    feed(other,4);rx_poll();assert(notes==3);
    assert(!crsf_set_map("AAAA"));assert(crsf_set_map("TAER"));rx_init();
    feed(f,26);rx_poll();assert(rx_channels()[0]>.99 && rx_channels()[1]==-1 && rx_channels()[3]==0);
    float bad[16]={0};uint32_t before=notes;bad[0]=NAN;
    rx_stub_set_channels(bad,16,true);assert(notes==before);
    bad[0]=0;rx_stub_set_channels(bad,4,true);assert(notes==before);
    bad[3]=-1;rx_stub_set_channels(bad,16,true);assert(notes==before);
    now=0xfffffff0u;rx_init();feed(f,26);rx_poll();now=20;assert(rx_frame_fresh());assert(rx_frame_age_ms()==36);
    assert(crsf_set_map("AETR"));
    link_gate_checks();
    return 0;
}
