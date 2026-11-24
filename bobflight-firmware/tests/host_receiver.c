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
/* CRSF LINK_STATISTICS 0x14: 10-byte payload, uplink LQ at payload byte 2,
 * rf_profile at payload byte 5 (4fps=0, 50fps=1, 150fps=2). */
static void stats_full(uint8_t r1, uint8_t r2, uint8_t lq, int8_t snr, uint8_t ant, uint8_t rf){
    uint8_t s[14]={0xc8,12,0x14,r1,r2,lq,(uint8_t)snr,ant,rf,3,70,98,5,0};s[13]=crsf_crc8(s+2,11);feed(s,14);
}
static void stats_rf(uint8_t lq,uint8_t rf){
    stats_full(60, 62, lq, 9, 0, rf);
}
static void stats(uint8_t lq){stats_rf(lq,2);}
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
/* N2: rf_mode is a vendor index, not a rate (TBS 0 = 4 fps, ExpressLRS 4.x
 * 0 = 900 MHz 25 Hz), so it never closes the gate. The ~4 Hz policy is kept by
 * measuring the RC frames: the last RX_LINK_RATE_FRAMES valid frames spanning
 * more than RX_LINK_RATE_SPAN_MS is link-rate-low. Only with stats present (as before). */
static unsigned feed_every(uint8_t *f,unsigned ms,unsigned gap,unsigned stats_gap,uint8_t lq,uint8_t rf,rx_loss_reason_t expect){
    /* Advance `ms` in 5 ms polls, an RC frame every `gap` ms and stats every
     * `stats_gap` ms; every poll must report `expect`. Returns frames fed. */
    unsigned fed=0;
    for(unsigned t=0;t<ms;t+=5){
        if(t%stats_gap==0)stats_rf(lq,rf);
        if(t%gap==0){feed(f,26);fed++;}
        now+=5;rx_poll();
        assert(rx_loss_reason()==expect);
    }
    return fed;
}
static void rf_mode_checks(void){
    uint8_t f[26],g[26];frame(f);frame_roll(g,992);
    now=200000;used=0;rx_init();
    /* Stats absent: frames-only, unchanged. */
    assert(!rx_link_stats_present()&&rx_loss_reason()==RX_LOSS_NO_FRAMES);
    run_ms(100,f);assert(rx_loss_reason()==RX_LOSS_NONE&&!rx_link_stats_present()&&rx_frame_fresh());
    /* rf 0 (ELRS 4.x 25 Hz), 1, 2 and an out-of-table 7 with good LQ: no loss, every frame accepted. */
    const uint8_t rfs[4]={0,1,2,7};
    for(unsigned i=0;i<4;i++){stats_rf(80,rfs[i]);uint32_t n=notes;run_ms(100,f);
        assert(notes==n+10&&rx_loss_reason()==RX_LOSS_NONE&&rx_link_lq()==80&&rx_frame_fresh());}
    /* ELRS 900 MHz 25 Hz: rf_mode 0, LQ 90, a frame every 40 ms, stats every 200 ms, 5 s: never a loss. */
    {uint32_t n=notes;unsigned fed=feed_every(f,5000,40,200,90,0,RX_LOSS_NONE);
     assert(fed==125&&notes==n+125&&rx_frame_fresh()&&rx_link_lq()==90);}
    /* 25 Hz at LQ 50 (every other packet lost: a frame every 80 ms): still no loss. */
    {uint32_t n=notes;unsigned fed=feed_every(f,2000,80,200,50,0,RX_LOSS_NONE);assert(notes==n+fed&&rx_frame_fresh());}
    /* LQ 0 is loss whatever the rf_mode: frames refresh nothing. */
    stats_rf(0,0);rx_poll();
    {uint32_t n=notes,c=rx_frame_count();run_ms(240,g);
     assert(notes==n&&rx_frame_count()==c&&rx_loss_reason()==RX_LOSS_LQ_ZERO&&rx_link_lq()==0);}
    run_ms(20,g);assert(!rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_LQ_ZERO);
    stats_rf(0,2);rx_poll();assert(rx_loss_reason()==RX_LOSS_LQ_ZERO);
    /* Recovery with rf_mode 0 and LQ > 0: the gate reopens, the next frame is accepted. */
    stats_rf(60,0);{uint32_t n=notes;run_ms(10,g);assert(notes==n+1&&rx_frame_fresh()&&rx_channels()[0]==0&&rx_loss_reason()==RX_LOSS_NONE);}
    /* Stale stats are loss whatever the rf_mode: exactly 1000 ms is fine, 1001 ms is stats-stale. */
    stats_rf(60,0);rx_poll();uint32_t t=now;
    while(now-t<1000u){now+=5;if((now-t)%10==0)feed(f,26);rx_poll();assert(rx_loss_reason()==RX_LOSS_NONE);}
    {uint32_t n=notes;feed(f,26);now+=1;rx_poll();assert(notes==n&&rx_loss_reason()==RX_LOSS_STATS_STALE&&rx_link_lq()==-1);}
    run_ms(300,f);assert(rx_loss_reason()==RX_LOSS_STATS_STALE&&!rx_frame_fresh());
    /* ~4 Hz policy unchanged: a frame every 200 ms (each one inside the 250 ms frame
     * timeout) with fresh LQ 80 stats is link-rate-low, whatever the rf_mode; the
     * frames refresh nothing, so the existing failsafe timeout runs. */
    for(unsigned i=0;i<3;i++){
        const uint8_t rf=(uint8_t)(i==0?0:i==1?1:2);
        now+=1000;used=0;rx_init();
        uint32_t n=notes,c=rx_frame_count();
        stats_rf(80,rf);rx_poll();
        unsigned fed=feed_every(g,2000,200,100,80,rf,RX_LOSS_LINK_RATE_LOW);
        assert(fed==10&&notes==n&&rx_frame_count()==c&&!rx_frame_fresh()&&rx_link_lq()==80);
        assert(!strcmp(rx_loss_reason_name(RX_LOSS_LINK_RATE_LOW),"link-rate-low"));
    }
    /* The same link back at 25 Hz: the first fast frame is still held back (the
     * last 8 frames span more than 1000 ms); after 8 fast frames the gate is open. */
    {uint32_t n=notes;stats_rf(80,0);feed(f,26);now+=5;rx_poll();assert(notes==n&&rx_loss_reason()==RX_LOSS_LINK_RATE_LOW);
     for(unsigned i=0;i<7;i++){run_ms(35,NULL);stats_rf(80,0);feed(f,26);now+=5;rx_poll();}
     assert(notes>n&&rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE);}
    /* Unknown rate fails closed: with stats seen first, frames 1..7 after rx_init are held back;
     * the 8th (25 Hz) is accepted. */
    now+=1000;used=0;rx_init();
    {uint32_t n=notes;stats_rf(80,0);rx_poll();
     for(unsigned i=0;i<7;i++){feed(f,26);now+=5;rx_poll();assert(notes==n&&rx_loss_reason()==RX_LOSS_LINK_RATE_LOW);run_ms(35,NULL);}
     feed(f,26);now+=5;rx_poll();assert(notes==n+1&&rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE);}
    /* Priority: lq-zero beats link-rate-low; no-frames beats everything. */
    now+=1000;used=0;rx_init();stats_rf(0,2);rx_poll();feed(f,26);now+=5;rx_poll();
    assert(rx_loss_reason()==RX_LOSS_LQ_ZERO);
    run_ms(255,NULL);assert(rx_loss_reason()==RX_LOSS_NO_FRAMES);
    /* Stats absent: a 4 Hz frame stream stays frames-only exactly as before. */
    now+=1000;used=0;rx_init();
    for(unsigned i=0;i<10;i++){feed(f,26);now+=5;rx_poll();assert(rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE);run_ms(195,NULL);}
    /* Re-initialisation forgets the stats and the frame history. */
    rx_init();feed(f,26);rx_poll();assert(rx_frame_fresh()&&rx_loss_reason()==RX_LOSS_NONE&&!rx_link_stats_present());
}

static void snapshot_checks(void){
    uint8_t f[26];frame(f);
    now=300000;used=0;rx_init();
    rx_link_stats_snapshot_t snap;

    /* Before any stats frame: !valid, !fresh, age = UINT32_MAX, no fabricated zeros for valid stat data */
    assert(!rx_link_stats_snapshot(&snap));
    assert(!snap.valid);
    assert(!snap.fresh);
    assert(snap.age_ms == UINT32_MAX);

    /* Feed valid LINK_STATISTICS frame */
    stats_full(70, 72, 95, 12, 1, 2);
    rx_poll();
    assert(rx_link_stats_snapshot(&snap));
    assert(snap.valid);
    assert(snap.fresh);
    assert(snap.age_ms == 0);
    assert(snap.rssi1_dbm == -70);
    assert(snap.rssi2_dbm == -72);
    assert(snap.uplink_lq == 95);
    assert(snap.uplink_snr == 12);
    assert(snap.active_antenna == 1);
    assert(snap.rf_mode == 2);

    /* Link-stat freshness is independent of RC frames: RC frames keep arriving, link stats age out */
    run_ms(900, f);
    assert(rx_link_stats_snapshot(&snap));
    assert(snap.valid && snap.fresh && snap.age_ms == 900);

    /* Cross 1000 ms staleness threshold: stats become stale even as RC frames continue */
    run_ms(105, f);
    assert(!rx_link_stats_snapshot(&snap));
    assert(snap.valid);
    assert(!snap.fresh);
    assert(snap.age_ms == 1005);
    assert(rx_frame_fresh()); /* RC frames still fresh */

    /* Re-init clears snapshot validity */
    rx_init();
    assert(!rx_link_stats_snapshot(&snap));
    assert(!snap.valid);
    assert(!snap.fresh);
    assert(snap.age_ms == UINT32_MAX);

    /* Out-of-bounds antenna frame (antenna 2) is rejected */
    stats_full(60, 62, 90, 10, 2, 1);
    rx_poll();
    assert(!rx_link_stats_snapshot(&snap));
    assert(!snap.valid);
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
    rf_mode_checks();
    snapshot_checks();
    return 0;
}
