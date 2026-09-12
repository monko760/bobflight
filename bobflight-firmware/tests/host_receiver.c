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
static void frame(uint8_t f[26]){
    uint16_t values[16];for(unsigned i=0;i<16;i++)values[i]=992;
    values[0]=172;values[1]=1811;values[2]=172;values[3]=992;values[15]=1811;
    memset(f,0,26);f[0]=0xc8;f[1]=24;f[2]=0x16;
    for(unsigned c=0;c<16;c++)for(unsigned b=0;b<11;b++)
        if(values[c]&(1u<<b))f[3+(c*11+b)/8]|=1u<<((c*11+b)%8);
    f[25]=crsf_crc8(f+2,23);
}
static void feed(const uint8_t *p,size_t n){assert(n+used<=sizeof(wire));memcpy(wire+used,p,n);used+=n;}
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
    return 0;
}
