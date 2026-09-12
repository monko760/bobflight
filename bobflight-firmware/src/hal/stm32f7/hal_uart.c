/* SPDX-License-Identifier: Apache-2.0
 * USART6 receiver, STM32F745 RM0385. IRQ ring keeps CRSF bytes across USB work. */
#include "hal_f7_priv.h"
#include "board/board.h"
typedef struct {volatile uint32_t CR1,CR2,CR3,BRR,GTPR,RTOR,RQR,ISR,ICR,RDR,TDR;} uart_regs_t;
struct hal_uart {uart_regs_t *r; volatile uint16_t head,tail; volatile uint32_t errors; uint8_t ring[512]; bool open;};
static hal_uart_t port;
static unsigned active_irq=71;
static void receiver_irq(void) {
    if(!port.open) return;
    uint32_t status=port.r->ISR;
    if(status & 15u) {port.r->ICR=15u; port.errors++;}
    if(status & (1u<<5)) {
        uint8_t b=(uint8_t)port.r->RDR;
        if(status & 15u) return;
        uint16_t next=(port.head+1u)&511u;
        if(next!=port.tail) {port.ring[port.head]=b; __DMB(); port.head=next;}
        else port.errors++;
    }
}
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *cfg) {
    if(!cfg || !board_mmio_permitted() || !cfg->baud || !hal_pin_valid(cfg->rx))return 0;
    uintptr_t base; unsigned irq,enable,mux; bool apb2=false;
    switch(cfg->instance){
    case 1:base=0x40011000;irq=37;enable=4;mux=0;apb2=true;break;
    case 2:base=0x40004400;irq=38;enable=17;mux=2;break;
    case 3:base=0x40004800;irq=39;enable=18;mux=4;break;
    case 4:base=0x40004C00;irq=52;enable=19;mux=6;break;
    case 6:base=0x40011400;irq=71;enable=5;mux=10;apb2=true;break;
    case 7:base=0x40007800;irq=82;enable=30;mux=12;break;
    default:return 0;
    }
    NVIC_DisableIRQ((IRQn_Type)active_irq);if(port.open)port.r->CR1=0;
    port.open=false;
    if(apb2)HAL_F7_RCC->APB2ENR|=1u<<enable;else HAL_F7_RCC->APB1ENR|=1u<<enable;
    (void)HAL_F7_RCC->APB2ENR;HAL_F7_RCC->DCKCFGR2&=~(3u<<mux);
    port.r=(uart_regs_t*)base;port.r->CR1=0;active_irq=irq;
    hal_gpio_cfg_t af={HAL_GPIO_AF,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_HIGH,(uint8_t)((cfg->instance==4 || cfg->instance>=6)?8:7)};
    if(!hal_gpio_configure(cfg->rx,&af))return 0;
    if(hal_pin_valid(cfg->tx) && !hal_gpio_configure(cfg->tx,&af))return 0;
    port.r->CR2=0;port.r->CR3=0;port.r->BRR=(hal_f7_pclk(apb2)+cfg->baud/2)/cfg->baud;
    port.head=port.tail=0; port.errors=0; port.open=true;
    port.r->ICR=0xFFFFFFFFu; port.r->CR1=1u|(1u<<2)|(1u<<3)|(1u<<5);
    NVIC_ClearPendingIRQ((IRQn_Type)active_irq); NVIC_SetPriority((IRQn_Type)active_irq,2); NVIC_EnableIRQ((IRQn_Type)active_irq);
    return &port;
}
hal_uart_t *hal_uart_open(unsigned instance,uint32_t baud) {
    const board_t *b=board_get(); hal_uart_cfg_t cfg={instance,baud,b->rx_pin,b->tx_pin}; return hal_uart_open_cfg(&cfg);
}
size_t hal_uart_read(hal_uart_t *u,uint8_t *buf,size_t maxlen) {
    if(!u || !u->open || !buf) return 0;
    size_t n=0; while(n<maxlen && u->tail!=u->head) {buf[n++]=u->ring[u->tail]; __DMB(); u->tail=(u->tail+1u)&511u;} return n;
}
size_t hal_uart_write(hal_uart_t *u,const uint8_t *buf,size_t len) {
    if(!u || !u->open || !buf) return 0;
    size_t n=0; while(n<len) {unsigned timeout=10000; while(!(u->r->ISR&(1u<<7))) if(!--timeout)return n; u->r->TDR=buf[n++];} return n;
}

void USART1_IRQHandler(void){receiver_irq();}
void USART2_IRQHandler(void){receiver_irq();}
void USART3_IRQHandler(void){receiver_irq();}
void UART4_IRQHandler(void){receiver_irq();}
void USART6_IRQHandler(void){receiver_irq();}
void UART7_IRQHandler(void){receiver_irq();}

