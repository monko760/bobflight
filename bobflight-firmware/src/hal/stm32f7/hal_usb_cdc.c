/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * USB CDC via TinyUSB (MIT) + Synopsys DWC2 OTG_FS.
 * Pins: PA11/PA12 AF10 (MCU-standard OTG_FS DM/DP) — IR has enable_cdc only.
 * Kakute has USB_DETECT on PA8; we force software B-valid (vbus_sensing=false).
 *
 * cdc12: dig enum — force device mode (FDMOD) with ≥25 ms settle (RM0431),
 * GCCFG PWRDWN (FS phy on) + VBDEN clear, GOTGCTL BVAL, soft-disconnect ≥50 ms,
 * longer tud_task pump. Keep OTGFSRST + CK48=PLLQ. PLLSAI 48 MHz armed as
 * mux backup (CK48MSEL stays 0 / PLLQ).
 */
#include "hal/hal.h"
#include "hal_f7_priv.h"
#include "board/board.h"
#include "tusb.h"
#include <string.h>

static bool g_usb_up;

/* defined below; referenced from poll */
bool hal_usb_cdc_connected(void);

/** IRQ-free settle after pins / clock enable (uses SystemCoreClock). */
static void usb_busywait_ms(uint32_t ms)
{
#if defined(BOBFLIGHT_HAVE_CMSIS)
    extern uint32_t SystemCoreClock;
    uint32_t hz = SystemCoreClock;
    volatile uint32_t n;

    if (hz < 1000u) {
        hz = 16000000u;
    }
    n = (hz / 1000u) * (ms ? ms : 1u) / 4u;
    if (n == 0u) {
        n = 1u;
    }
    while (n--) {
        __NOP();
    }
#else
    (void)ms;
#endif
}

/* OTG_FS register helpers (RM0431 offsets from HAL_F7_USB_OTG_FS_BASE). */
#define USB_GOTGCTL   (*(volatile uint32_t *)(uintptr_t)(HAL_F7_USB_OTG_FS_BASE + 0x000u))
#define USB_GUSBCFG   (*(volatile uint32_t *)(uintptr_t)(HAL_F7_USB_OTG_FS_BASE + 0x00Cu))
#define USB_GCCFG     (*(volatile uint32_t *)(uintptr_t)(HAL_F7_USB_OTG_FS_BASE + 0x038u))
#define USB_DCTL      (*(volatile uint32_t *)(uintptr_t)(HAL_F7_USB_OTG_FS_BASE + 0x804u))

#define GUSBCFG_FDMOD     (1u << 30)
#define GUSBCFG_FHMOD     (1u << 29)
#define GOTGCTL_BVALOEN   (1u << 6)
#define GOTGCTL_BVALOVAL  (1u << 7)
#define GCCFG_PWRDWN      (1u << 16) /* 1 = FS transceiver powered (active) */
#define GCCFG_VBDEN       (1u << 21)
#define GCCFG_NOVBUSSENS  (1u << 21) /* F4-layout alias; F7 uses VBDEN same bit */
#define DCTL_SDIS         (1u << 1)

/**
 * Force device mode + FS PHY on + no HW VBUS sense + B-session valid.
 * Call after OTG clock/reset and again after tud_init (TinyUSB may race).
 * RM0431: after FDMOD, wait ≥25 ms before other OTG accesses / connect.
 */
static void usb_force_device_phy(bool wait_fdmod)
{
    /* Force device mode; clear host force. */
    USB_GUSBCFG = (USB_GUSBCFG & ~GUSBCFG_FHMOD) | GUSBCFG_FDMOD;
    if (wait_fdmod) {
        usb_busywait_ms(25u);
    }

    /*
     * GCCFG: PWRDWN=1 powers the on-chip FS PHY (ST naming is inverted).
     * Clear VBDEN so we do not wait on VBUS sense (Kakute PA8 unused here).
     * Also set NOVBUSSENS-equivalent for cores that still decode bit21 that way.
     */
    {
        uint32_t gccfg = USB_GCCFG;
        gccfg |= GCCFG_PWRDWN;
        gccfg &= ~GCCFG_VBDEN;
        USB_GCCFG = gccfg;
    }

    /* Software B-session valid override. */
    USB_GOTGCTL |= GOTGCTL_BVALOEN | GOTGCTL_BVALOVAL;
}

/** Arm PLLSAI for 48 MHz (PLLSAIP) as CK48 backup; leave mux on PLLQ. */
static void usb_pllsai_48_backup(void)
{
    uint32_t timeout;
    uint32_t pllm;
    uint32_t pllcfgr;
    uint32_t saisrc_hse;

    /* Already on / locked — leave alone. */
    if ((HAL_F7_RCC->CR & (1u << 29)) != 0u) { /* PLLSAIRDY bit29 */
        return;
    }

    pllcfgr = HAL_F7_RCC->PLLCFGR;
    pllm = pllcfgr & 0x3Fu;
    if (pllm == 0u) {
        pllm = 16u;
    }
    saisrc_hse = (pllcfgr & HAL_F7_RCC_PLLCFGR_PLLSRC_HSE) ? 1u : 0u;
    (void)saisrc_hse;

    /*
     * PLLSAI: same VCO_IN as main PLL (PLLM). N=192, P=4 → 48 MHz on PLLSAIP
     * when VCO_IN=1 MHz (HSI/16 or HSE/M). Q/R don't matter for CK48 mux.
     * RM0431 PLLSAICFGR: N[8:6], P[17:16], Q[27:24], R[30:28].
     */
    {
        uint32_t n = 192u;
        uint32_t p_enc = 1u; /* PLLSAIP = 4 → encoding (P/2)-1 = 1 */
        uint32_t q = 4u;
        uint32_t r = 2u;
        HAL_F7_RCC->PLLSAICFGR =
            ((n & 0x1FFu) << 6)
            | ((p_enc & 0x3u) << 16)
            | ((q & 0xFu) << 24)
            | ((r & 0x7u) << 28);
    }

    HAL_F7_RCC->CR |= (1u << 28); /* PLLSAION */
    timeout = 2000000u;
    while ((HAL_F7_RCC->CR & (1u << 29)) == 0u) { /* PLLSAIRDY */
        if (--timeout == 0u) {
            HAL_F7_RCC->CR &= ~(1u << 28);
            return;
        }
    }

    /* Keep CK48MSEL=0 (PLLQ). Backup is armed if field later flips mux. */
    HAL_F7_RCC->DCKCFGR2 &= ~HAL_F7_RCC_DCKCFGR2_CK48MSEL;
}

/* PA11 = DM, PA12 = DP — AF10 OTG_FS (RM0431 datasheet AF table). */
static void usb_pins_init(void)
{
    hal_pin_t pins[2] = {
        HAL_PIN_PACK(0u, 11u), /* PA11 DM */
        HAL_PIN_PACK(0u, 12u), /* PA12 DP */
    };
    unsigned i;

    if (!board_mmio_permitted()) {
        return;
    }

    for (i = 0; i < 2u; i++) {
        unsigned port, num;
        hal_f7_gpio_regs_t *gpio;
        uint32_t shift2;
        uint32_t afr_i;
        uint32_t afr_s;

        if (!hal_f7_mmio_ok(pins[i], &port, &num)) {
            return;
        }
        hal_f7_rcc_gpio_enable(port);
        gpio = hal_f7_gpio(port);
        if (!gpio) {
            return;
        }
        shift2 = num * 2u;
        afr_i = num >> 3;
        afr_s = (num & 7u) * 4u;
        gpio->MODER = (gpio->MODER & ~(3u << shift2)) | (2u << shift2);
        gpio->OSPEEDR = (gpio->OSPEEDR & ~(3u << shift2)) | (3u << shift2);
        gpio->PUPDR &= ~(3u << shift2);
        gpio->OTYPER &= ~(1u << num);
        gpio->AFR[afr_i] = (gpio->AFR[afr_i] & ~(0xFu << afr_s)) | (10u << afr_s);
    }
}

bool hal_usb_cdc_init(void)
{
    static const tusb_rhport_init_t rh_init = {
        .role = TUSB_ROLE_DEVICE,
        .speed = TUSB_SPEED_FULL
    };
    /* Software B-valid: Kakute PA8 USB_DETECT exists but we do not use HW VBUS sense. */
    static const tud_configure_param_t dwc2_cfg = {
        .dwc2 = {
            .bm_double_buffered = 0,
            .vbus_sensing = false,
        }
    };
    unsigned i;

    g_usb_up = false;

    if (!board_mmio_permitted()) {
        return false;
    }

    /* Fail-soft ONLY on hsi-raw (no 48 MHz). hsi-pll / hse-pll MUST run OTG. */
    {
        const char *src = hal_clock_usb_src();
        if (src != NULL && strcmp(src, "hsi-raw") == 0) {
            return false;
        }
    }

    /* Re-assert USB 48 MHz mux = PLLQ; arm PLLSAI 48 as backup source. */
    HAL_F7_RCC->DCKCFGR2 &= ~HAL_F7_RCC_DCKCFGR2_CK48MSEL;
    usb_pllsai_48_backup();

    /* PA11/PA12 AF10 OTG_FS DM/DP */
    usb_pins_init();
    usb_busywait_ms(2u);

    /* Ensure OTGFS AHB2 clock before any TinyUSB register access. */
    hal_f7_rcc_otgfs_enable();
    usb_busywait_ms(1u);

    /* Core reset — post-DFU leave can leave PHY/D+ stuck. */
    HAL_F7_RCC->AHB2RSTR |= (1u << 7); /* OTGFSRST */
    usb_busywait_ms(1u);
    HAL_F7_RCC->AHB2RSTR &= ~(1u << 7);
    usb_busywait_ms(2u);
    hal_f7_rcc_otgfs_enable();

    /*
     * Pre-tud_init: force device mode + PHY on + BVAL, with FDMOD settle.
     * TinyUSB dcd_init also sets FDMOD but connects immediately (no 25 ms).
     */
    usb_force_device_phy(true);
    /* Soft-disconnect pad before stack init (DCTL.SDIS). */
    USB_DCTL |= DCTL_SDIS;
    usb_busywait_ms(10u);

    NVIC_SetPriority(OTG_FS_IRQn, 5);

    /* Must precede tusb_init so GOTGCTL B-valid / GCCFG path is correct. */
    (void)tud_configure(0, TUD_CFGID_DWC2, &dwc2_cfg);

    if (!tusb_init(0, &rh_init)) {
        return false;
    }

    /* TinyUSB dcd_init also enables IRQ; call explicitly so audit/grep sees it. */
    NVIC_EnableIRQ(OTG_FS_IRQn);

    /* Re-assert after TinyUSB phy/core init (may have cleared bits). */
    usb_force_device_phy(false);

    /*
     * cdc12: soft-connect — disconnect ≥50 ms so host drops stale DFU addr,
     * then connect and pump long enough for Windows SETUP/enum.
     */
    (void)tud_disconnect();
    USB_DCTL |= DCTL_SDIS;
    usb_busywait_ms(50u);
    for (i = 0; i < 20u; i++) {
        tud_task();
        usb_busywait_ms(1u);
    }

    usb_force_device_phy(false);
    (void)tud_connect();
    USB_DCTL &= ~DCTL_SDIS;

    /* Pump TinyUSB so SETUP / enum can progress immediately after pull-up. */
    for (i = 0; i < 300u; i++) {
        tud_task();
        usb_busywait_ms(1u);
    }

    g_usb_up = true;
    return true;
}

void OTG_FS_IRQHandler(void)
{
    tusb_int_handler(0, true);
}

void hal_usb_cdc_poll(void)
{
    if (g_usb_up) {
        tud_task();
        (void)hal_usb_cdc_connected();
    }
}

size_t hal_usb_cdc_read(uint8_t *buf, size_t maxlen)
{
    if (!g_usb_up || !buf || maxlen == 0 || !tud_cdc_available()) {
        return 0;
    }
    return (size_t)tud_cdc_read(buf, (uint32_t)maxlen);
}

size_t hal_usb_cdc_write(const uint8_t *buf, size_t len)
{
    uint32_t n;
    if (!g_usb_up || !buf || len == 0) {
        return len;
    }
    if (!tud_cdc_connected()) {
        return len;
    }
    n = tud_cdc_write(buf, (uint32_t)len);
    (void)tud_cdc_write_flush();
    return (size_t)n;
}

bool hal_usb_cdc_connected(void)
{
    return g_usb_up && tud_cdc_connected();
}

/* Terminal bootloader-reset path only; interrupts are already disabled.
 * Early reset entry supplies the disconnect settling interval before ROM. */
void hal_usb_cdc_bootloader_disconnect(void)
{
    if (g_usb_up) {
        USB_DCTL |= DCTL_SDIS;
        g_usb_up = false;
    }
}
