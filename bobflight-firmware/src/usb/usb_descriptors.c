/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned USB CDC (IAD) descriptors for BobFlight. Not copied from Betaflight.
 * Windows-friendly: MISC/IAD device class + TUD_CDC_DESCRIPTOR (includes IAD).
 * Serial string is unique per MCU (96-bit UID) so Windows binds a stable COM.
 */
#include "tusb.h"
#include <string.h>
#include <stdio.h>

#define USB_VID   0x1209u /* pid.codes / open */
#define USB_PID   0xB0B1u /* BobFlight CDC placeholder — replace if assigned */
#define USB_BCD   0x0200u

enum {
    ITF_NUM_CDC = 0,
    ITF_NUM_CDC_DATA,
    ITF_NUM_TOTAL
};

#define EPNUM_CDC_NOTIF 0x81u
#define EPNUM_CDC_OUT   0x02u
#define EPNUM_CDC_IN    0x82u

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN)

/*
 * STM32F74x unique device ID base (RM0431). F72x uses 0x1FF07A10 — both
 * Kakute (F745) and T-Motor (F722) builds share this TU file; pick at compile.
 */
#if defined(STM32F722xx) || (defined(BOBFLIGHT_TARGET_MCU_STM32F722))
#define BF_UID_BASE 0x1FF07A10u
#else
#define BF_UID_BASE 0x1FF0F420u /* F745 / F74x default */
#endif

static tusb_desc_device_t const desc_device = {
    .bLength            = sizeof(tusb_desc_device_t),
    .bDescriptorType    = TUSB_DESC_DEVICE,
    .bcdUSB             = USB_BCD,
    .bDeviceClass       = TUSB_CLASS_MISC,
    .bDeviceSubClass    = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol    = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor           = USB_VID,
    .idProduct          = USB_PID,
    .bcdDevice          = 0x0112, /* cdc12 */
    .iManufacturer      = 0x01,
    .iProduct           = 0x02,
    .iSerialNumber      = 0x03,
    .bNumConfigurations = 0x01
};

uint8_t const *tud_descriptor_device_cb(void)
{
    return (uint8_t const *)&desc_device;
}

/* bmAttributes 0x80: bus-powered, USB 2.0 D7 reserved=1 (not 0x00). */
static uint8_t const desc_fs_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x80, 100),
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8,
                       EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
};

uint8_t const *tud_descriptor_configuration_cb(uint8_t index)
{
    (void)index;
    return desc_fs_configuration;
}

static char g_serial_ascii[25]; /* 24 hex chars + NUL from 96-bit UID */
static bool g_serial_ready;

static void serial_from_uid(void)
{
    const volatile uint32_t *uid = (const volatile uint32_t *)(uintptr_t)BF_UID_BASE;
    uint32_t w0, w1, w2;

    if (g_serial_ready) {
        return;
    }
    w0 = uid[0];
    w1 = uid[1];
    w2 = uid[2];
    /* Fixed-width hex — unique per chip, stable across resets. */
    (void)snprintf(g_serial_ascii, sizeof(g_serial_ascii),
                   "%08lX%08lX%08lX",
                   (unsigned long)w2, (unsigned long)w1, (unsigned long)w0);
    if (g_serial_ascii[0] == '\0') {
        memcpy(g_serial_ascii, "BFCDC12DEAD", 12);
    }
    g_serial_ready = true;
}

static char const *string_desc_arr[] = {
    (const char[]){0x09, 0x04}, /* English (0x0409) */
    "BobFlight",
    "BobFlight CDC",
    NULL, /* index 3 — filled from UID at runtime */
    "BobFlight Serial",
};

static uint16_t _desc_str[32];

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;
    uint8_t chr_count;
    const char *str;

    if (index == 0) {
        memcpy(&_desc_str[1], string_desc_arr[0], 2);
        chr_count = 1;
    } else {
        if (!(index < sizeof(string_desc_arr) / sizeof(string_desc_arr[0]))) {
            return NULL;
        }
        if (index == 3) {
            serial_from_uid();
            str = g_serial_ascii;
        } else {
            str = string_desc_arr[index];
        }
        if (str == NULL) {
            return NULL;
        }
        chr_count = (uint8_t)strlen(str);
        if (chr_count > 31) {
            chr_count = 31;
        }
        for (uint8_t i = 0; i < chr_count; i++) {
            _desc_str[1 + i] = (uint16_t)(uint8_t)str[i];
        }
    }

    _desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * chr_count + 2));
    return _desc_str;
}
