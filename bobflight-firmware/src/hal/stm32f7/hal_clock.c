/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * F7 clock + time (cdc10). HSI→PLL 168 (no OD) first for USB 48 MHz,
 * then 216+OD; HSE crystal then HSEBYP second. PLLCFGR keeps bit29.
 * SysTick 1 ms. Kakute: 8 MHz HSE assumption until Hardware fills IR.
 */
#include "hal/hal.h"
#include "hal_f7_priv.h"
#include "board/board.h"
#include "hal/cycle_clock.h"

uint32_t SystemCoreClock = 16000000u; /* HSI default until PLL */

static volatile uint32_t g_ms;
static uint32_t g_hse_mhz;
static volatile uint64_t g_tick_us;
static uint64_t g_last_us;
#if defined(BOBFLIGHT_HAVE_CMSIS)
static cycle_clock_t g_cycle_clock;
static volatile bool g_dwt_ready;
static uint32_t g_time_core_hz;
/* Called only with normal interrupts masked, including from SysTick. */
static void clock_fold_cycles(void){
 if(g_dwt_ready){
  if(SystemCoreClock!=g_time_core_hz || !(CoreDebug->DEMCR&CoreDebug_DEMCR_TRCENA_Msk) ||
     !(DWT->CTRL&DWT_CTRL_CYCCNTENA_Msk))g_dwt_ready=false;
  else (void)cycle_clock_update(&g_cycle_clock,DWT->CYCCNT);
 }
}
#endif

/* Which path supplied SYSCLK / USB 48 MHz (for CLI / Lead LED encode). */
static const char *g_usb_clk_src = "hsi-raw";

#if defined(BOBFLIGHT_HAVE_CMSIS)
uint32_t tusb_time_millis_api(void);

void SysTick_Handler(void)
{
    uint32_t mask=__get_PRIMASK();__disable_irq();
    g_ms++;g_tick_us+=1000u;
    clock_fold_cycles(); /* Extend CYCCNT before its ~20–268 second wrap. */
    __set_PRIMASK(mask);
    (void)tusb_time_millis_api(); /* retain for TinyUSB OPT_OS_NONE */
}

static void clock_busywait(volatile uint32_t n)
{
    while (n--) {
        __NOP();
    }
}

/** Busywait ~ms using SystemCoreClock (IRQ-free; used after PLL lock). */
static void clock_settle_ms(uint32_t ms)
{
    uint32_t hz = SystemCoreClock;
    volatile uint32_t n;

    if (hz < 1000u) {
        hz = 16000000u;
    }
    /* ~4 cycles/iter guess */
    n = (hz / 1000u) * (ms ? ms : 1u) / 4u;
    if (n == 0u) {
        n = 1u;
    }
    clock_busywait(n);
}

static void clock_pll_off(void)
{
    uint32_t timeout;

    if (HAL_F7_RCC->CR & HAL_F7_RCC_CR_PLLON) {
        HAL_F7_RCC->CR &= ~HAL_F7_RCC_CR_PLLON;
        timeout = 1000000u;
        while (HAL_F7_RCC->CR & HAL_F7_RCC_CR_PLLRDY) {
            if (--timeout == 0u) {
                break;
            }
        }
    }
}

static bool clock_reset_to_hsi(void)
{
    uint32_t timeout = 1000000u;
    HAL_F7_RCC->CR |= HAL_F7_RCC_CR_HSION;
    while ((HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSIRDY) == 0u) {
        if (--timeout == 0u) return false;
    }
    /* DFU can leave SYSCLK on PLL; select HSI before stopping inherited clocks. */
    HAL_F7_RCC->CFGR &= ~0x3u;
    timeout = 1000000u;
    while ((HAL_F7_RCC->CFGR & HAL_F7_RCC_CFGR_SWS_Msk) != 0u) {
        if (--timeout == 0u) return false;
    }
    HAL_F7_RCC->CR &= ~(HAL_F7_RCC_CR_PLLON | HAL_F7_RCC_CR_HSEON | HAL_F7_RCC_CR_HSEBYP);
    timeout = 1000000u;
    while (HAL_F7_RCC->CR & (HAL_F7_RCC_CR_PLLRDY | HAL_F7_RCC_CR_HSERDY)) {
        if (--timeout == 0u) return false;
    }
    HAL_F7_RCC->CFGR &= ~0xFFFCu;
    return true;
}
/** Clear HSEON and wait HSERDY clear so a half-started HSE cannot disturb HSI-PLL. */
static void clock_hse_off(void)
{
    uint32_t timeout;

    HAL_F7_RCC->CR &= ~(HAL_F7_RCC_CR_HSEON | HAL_F7_RCC_CR_HSEBYP);
    timeout = 1000000u;
    while (HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSERDY) {
        if (--timeout == 0u) {
            break;
        }
    }
}

/**
 * PWR Scale 1 + optional over-drive for 216 MHz (RM0431).
 * Wait VOSRDY after Scale1 before OD/PLL. All waits bounded; best-effort OD.
 */
static void clock_pwr_scale1_od(bool want_od)
{
    uint32_t timeout;

    HAL_F7_RCC->APB1ENR |= HAL_F7_RCC_APB1ENR_PWREN;
    (void)HAL_F7_RCC->APB1ENR;
    {
        uint32_t cr1 = HAL_F7_PWR->CR1;
        cr1 = (cr1 & ~HAL_F7_PWR_CR1_VOS_Msk) | HAL_F7_PWR_CR1_VOS_SCALE1;
        HAL_F7_PWR->CR1 = cr1;

        /* RM0431: wait VOSRDY after changing VOS before enabling OD / PLL. */
        timeout = 2000000u;
        while ((HAL_F7_PWR->CSR1 & HAL_F7_PWR_CSR1_VOSRDY) == 0u) {
            if (--timeout == 0u) {
                break;
            }
        }

        if (!want_od) {
            return;
        }

        HAL_F7_PWR->CR1 |= HAL_F7_PWR_CR1_ODEN;
        timeout = 2000000u;
        while ((HAL_F7_PWR->CSR1 & HAL_F7_PWR_CSR1_ODRDY) == 0u) {
            if (--timeout == 0u) {
                break;
            }
        }
        if (HAL_F7_PWR->CSR1 & HAL_F7_PWR_CSR1_ODRDY) {
            HAL_F7_PWR->CR1 |= HAL_F7_PWR_CR1_ODSWEN;
            timeout = 2000000u;
            while ((HAL_F7_PWR->CSR1 & HAL_F7_PWR_CSR1_ODSWRDY) == 0u) {
                if (--timeout == 0u) {
                    break;
                }
            }
        }
    }
}

/*
 * PLL → SYSCLK + PLLQ 48 MHz.
 * use_hse: PLLM = hse_mhz (VCO_IN = 1 MHz), SRC=HSE.
 * !use_hse: PLLM = 16 (HSI 16 MHz → 1 MHz), SRC=HSI (PLLSRC bit clear).
 * target_216: N=432 P=2 Q=9 → 216/48; else N=336 P=2 Q=7 → 168/48 (no OD needed).
 */
static bool clock_pll_lock(bool use_hse, uint32_t hse_mhz, bool target_216)
{
    uint32_t pllm;
    uint32_t plln;
    uint32_t pllp_enc = 0u; /* PLLP = 2 */
    uint32_t pllq;
    uint32_t timeout;
    uint32_t pllsrc = 0u;
    uint32_t flash_ws;
    uint32_t sysclk_hz;

    if (target_216) {
        plln = 432u;
        pllq = 9u;
        flash_ws = 7u;
        sysclk_hz = 216000000u;
    } else {
        /* 168 MHz without overdrive: VCO=336, /2=168, /7=48 USB */
        plln = 336u;
        pllq = 7u;
        flash_ws = 5u; /* ≥5 WS for 168 MHz @ 2.7–3.6 V */
        sysclk_hz = 168000000u;
    }

    if (use_hse) {
        if (hse_mhz < 4u || hse_mhz > 26u) {
            return false;
        }
        pllm = hse_mhz;
        pllsrc = HAL_F7_RCC_PLLCFGR_PLLSRC_HSE;

        /* Enable HSE crystal; if HSERDY fails try HSEBYP (TCXO / clock-in). */
        HAL_F7_RCC->CR &= ~HAL_F7_RCC_CR_HSEBYP;
        HAL_F7_RCC->CR |= HAL_F7_RCC_CR_HSEON;
        timeout = 20000000u;
        while ((HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSERDY) == 0u) {
            if (--timeout == 0u) {
                /* Crystal failed — bypass mode */
                HAL_F7_RCC->CR &= ~HAL_F7_RCC_CR_HSEON;
                timeout = 1000000u;
                while (HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSERDY) {
                    if (--timeout == 0u) {
                        break;
                    }
                }
                HAL_F7_RCC->CR |= HAL_F7_RCC_CR_HSEBYP;
                HAL_F7_RCC->CR |= HAL_F7_RCC_CR_HSEON;
                timeout = 20000000u;
                while ((HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSERDY) == 0u) {
                    if (--timeout == 0u) {
                        return false;
                    }
                }
                break;
            }
        }
    } else {
        pllm = 16u; /* HSI 16 MHz / 16 = 1 MHz VCO_IN */
        pllsrc = 0u; /* PLLSRC = HSI */

        /* Half-started HSE must not disturb HSI-PLL path. */
        clock_hse_off();

        /* Ensure HSI is on and ready (boot default, but be explicit). */
        HAL_F7_RCC->CR |= HAL_F7_RCC_CR_HSION;
        timeout = 1000000u;
        while ((HAL_F7_RCC->CR & HAL_F7_RCC_CR_HSIRDY) == 0u) {
            if (--timeout == 0u) {
                return false;
            }
        }
    }

    /* If PLL was left on from a failed path, turn it off before reconfig. */
    clock_pll_off();

    /* Flash latency + prefetch. Skip ARTEN on bring-up (cdc10) — latency+PRFTEN enough. */
    HAL_F7_FLASH->ACR = (HAL_F7_FLASH->ACR & ~(HAL_F7_FLASH_ACR_LATENCY_Msk | HAL_F7_FLASH_ACR_ARTEN))
                        | flash_ws | HAL_F7_FLASH_ACR_PRFTEN;

    /*
     * Configure PLL: M/N/P/Q + source.
     * RM0385: PLLCFGR bits 31:28 reserved — reset keeps bit29 (0x20000000).
     * A bare field OR (cdc8) cleared that bit and can prevent PLLRDY forever.
     */
    {
        uint32_t want =
            0x20000000u /* reserved bits 31:28 must match reset */
            | (pllm & 0x3Fu)
            | ((plln & 0x1FFu) << 6)
            | ((pllp_enc & 0x3u) << 16)
            | pllsrc
            | ((pllq & 0xFu) << 24);
        HAL_F7_RCC->PLLCFGR = want;
        /* Readback critical fields — silent mismatch → no lock */
        {
            uint32_t got = HAL_F7_RCC->PLLCFGR;
            uint32_t mask = 0x20000000u | 0x3Fu | (0x1FFu << 6) | (0x3u << 16) | (1u << 22) | (0xFu << 24);
            if ((got & mask) != (want & mask)) {
                return false;
            }
        }
    }

    HAL_F7_RCC->CR |= HAL_F7_RCC_CR_PLLON;
    timeout = 10000000u;
    while ((HAL_F7_RCC->CR & HAL_F7_RCC_CR_PLLRDY) == 0u) {
        if (--timeout == 0u) {
            return false;
        }
    }

    /* AHB=1, APB1=/4, APB2=/2 — common F7 high-speed layout */
    {
        uint32_t cfgr = HAL_F7_RCC->CFGR;
        cfgr &= ~0xFFFCu; /* clear HPRE/PPRE1/PPRE2 */
        cfgr |= (0x0u << 4);  /* HPRE div1 */
        cfgr |= (0x5u << 10); /* PPRE1 div4 */
        cfgr |= (0x4u << 13); /* PPRE2 div2 */
        HAL_F7_RCC->CFGR = cfgr;
    }

    /* Switch SYSCLK to PLL */
    {
        uint32_t cfgr = HAL_F7_RCC->CFGR;
        cfgr = (cfgr & ~0x3u) | HAL_F7_RCC_CFGR_SW_PLL;
        HAL_F7_RCC->CFGR = cfgr;
    }
    timeout = 10000000u;
    while ((HAL_F7_RCC->CFGR & HAL_F7_RCC_CFGR_SWS_Msk) != HAL_F7_RCC_CFGR_SWS_PLL) {
        if (--timeout == 0u) {
            return false;
        }
    }

    SystemCoreClock = sysclk_hz;

    /* USB 48 MHz mux: CK48MSEL=0 → PLLQ (RM0431 DCKCFGR2) */
    HAL_F7_RCC->DCKCFGR2 &= ~HAL_F7_RCC_DCKCFGR2_CK48MSEL;

    clock_settle_ms(2u);
    return true;
}

/** Try 168 (Scale1, no OD) first, then 216+OD. Sets g_usb_clk_src on success. */
static bool clock_try_pll_path(bool use_hse, uint32_t hse_mhz)
{
    /* Match Gate2: try 168 MHz before changing the power-scale setting. */
    if (clock_pll_lock(use_hse, hse_mhz, false)) {
        g_usb_clk_src = use_hse ? "hse-pll" : "hsi-pll";
        return true;
    }
    clock_pll_off();
    clock_pwr_scale1_od(true);
    if (clock_pll_lock(use_hse, hse_mhz, true)) {
        g_usb_clk_src = use_hse ? "hse-pll" : "hsi-pll";
        return true;
    }
    return false;
}
#endif /* BOBFLIGHT_HAVE_CMSIS */

const char *hal_clock_usb_src(void)
{
#if defined(BOBFLIGHT_HOST)
    return "host";
#else
    return g_usb_clk_src ? g_usb_clk_src : "hsi-raw";
#endif
}

void hal_clock_init(uint32_t hse_mhz)
{
    g_hse_mhz = hse_mhz;
    g_usb_clk_src = "hsi-raw";

#if defined(BOBFLIGHT_HAVE_CMSIS)
    if (!board_mmio_permitted()) {
        SystemCoreClock = 16000000u;
        SysTick_Config(SystemCoreClock / 1000u);
        return;
    }

    /*
     * Kakute's known-good Gate2 image starts from its documented 8 MHz HSE.
     * Use that path first so a cold boot follows the same clock sequence as
     * the image that is known to enumerate over USB. HSI remains a fallback
     * for boards without a declared crystal or for a failed HSE start.
     */
    if (hse_mhz > 0u && clock_try_pll_path(true, hse_mhz)) {
        SysTick_Config(SystemCoreClock / 1000u);
        NVIC_SetPriority(SysTick_IRQn, 0);
        return;
    }

    if (clock_reset_to_hsi() && clock_try_pll_path(false, 0u)) {
        SysTick_Config(SystemCoreClock / 1000u);
        NVIC_SetPriority(SysTick_IRQn, 0);
        return;
    }

    /* Last resort: raw HSI, no 48 MHz USB clock. Still return (fail-soft). */
    g_usb_clk_src = "hsi-raw";
    SystemCoreClock = 16000000u;
    SysTick_Config(SystemCoreClock / 1000u);
#else
    (void)g_hse_mhz;
#endif
}

void hal_time_init(void)
{
#if defined(BOBFLIGHT_HAVE_CMSIS)
    uint32_t mask=__get_PRIMASK();__disable_irq();
#endif
    g_ms=0;g_tick_us=0;g_last_us=0;
#if defined(BOBFLIGHT_HAVE_CMSIS)
    g_dwt_ready=false;g_time_core_hz=SystemCoreClock;
    if(board_mmio_permitted() && cycle_clock_init(&g_cycle_clock,SystemCoreClock,0)){
        CoreDebug->DEMCR|=CoreDebug_DEMCR_TRCENA_Msk;
        DWT->LAR=0xC5ACCE55u; /* ARM Cortex-M7 debug-component unlock key. */
        __DSB();__ISB();
        if(!(DWT->CTRL&DWT_CTRL_NOCYCCNT_Msk)){
            DWT->CTRL|=DWT_CTRL_CYCCNTENA_Msk;
            __DSB();__ISB();
            uint32_t before=DWT->CYCCNT;
            for(volatile unsigned i=0;i<64u;i++)__NOP();
            uint32_t after=DWT->CYCCNT;
            if(after!=before){
                (void)cycle_clock_init(&g_cycle_clock,SystemCoreClock,after);
                g_dwt_ready=true;
            }
        }
    }
    __set_PRIMASK(mask);
#endif
}

uint32_t hal_millis(void){return g_ms;}
uint32_t hal_core_clock_hz(void){return SystemCoreClock;}
bool hal_time_high_resolution(void){
#if defined(BOBFLIGHT_HAVE_CMSIS)
    uint32_t mask=__get_PRIMASK();__disable_irq();clock_fold_cycles();
    bool ready=g_dwt_ready;__set_PRIMASK(mask);return ready;
#else
    return false;
#endif
}
const char *hal_time_source(void){return hal_time_high_resolution()?"dwt-cyccnt":"systick-ms-fallback";}
uint64_t hal_micros(void)
{
#if defined(BOBFLIGHT_HAVE_CMSIS)
    uint32_t mask=__get_PRIMASK();__disable_irq();clock_fold_cycles();
    uint64_t now=g_dwt_ready?g_cycle_clock.us:g_tick_us;
#else
    uint64_t now=g_tick_us;
#endif
    /* A latched fallback never moves time backwards. Before initialization,
     * reads use the extended tick clock and are explicitly low resolution. */
    if(now<g_last_us)now=g_last_us;else g_last_us=now;
#if defined(BOBFLIGHT_HAVE_CMSIS)
    __set_PRIMASK(mask);
#endif
    return now;
}

void hal_delay_ms(uint32_t ms)
{
#if defined(BOBFLIGHT_HAVE_CMSIS)
    uint32_t start = g_ms;
    uint32_t spins = 0u;
    uint32_t limit;
    uint32_t hz = SystemCoreClock;

    /* Prefer SysTick/g_ms; if IRQ never advances, fall back to busywait. */
    if (hz < 1000u) {
        hz = 16000000u;
    }
    /* ~cycles budget for ms at ~4 cycles/spin check */
    limit = (hz / 1000u) * (ms ? ms : 1u);
    if (limit < 1000u) {
        limit = 1000u;
    }
    while ((g_ms - start) < ms) {
        if (++spins >= limit) {
            /* SysTick stuck (e.g. VTOR still at ROM) — crude busywait remainder */
            {
                volatile uint32_t n = (hz / 1000u) * ms / 4u;
                if (n == 0u) {
                    n = 1u;
                }
                while (n--) {
                    __NOP();
                }
            }
            uint32_t mask=__get_PRIMASK();__disable_irq();
            uint32_t elapsed=g_ms-start;
            if(elapsed<ms){g_tick_us+=(uint64_t)(ms-elapsed)*1000u;g_ms=start+ms;}
            __set_PRIMASK(mask);
            break;
        }
    }
#else
    g_ms += ms;g_tick_us+=(uint64_t)ms*1000u;
#endif
}

/* TinyUSB bare-metal time (OPT_OS_NONE) */
uint32_t tusb_time_millis_api(void)
{
    return g_ms;
}
