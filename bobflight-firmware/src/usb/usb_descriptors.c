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

#define USB_VID   0x1209u /* pid.codes / open */
#define USB_PID   0xB0B1u /* BobFlight CDC placeholder - replace if assigned */
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
 * STM32 unique device ID base. F405 uses 0x1FFF7A10. F72x uses 0x1FF07A10.
 * F745 uses 0x1FF0F420. Target is picked at compile time.
 */
#if defined(BF_F4_COMPONENT_F405XG) || defined(STM32F405xx) || defined(BOBFLIGHT_TARGET_MCU_STM32F405)
#define BF_UID_BASE 0x1FFF7A10u
#elif defined(STM32F722xx) || defined(BOBFLIGHT_TARGET_MCU_STM32F722)
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

static void u32_to_hex8(char *buf, uint32_t val)
{
    static const char hex_digits[] = "0123456789ABCDEF";
    for (int i = 0; i < 8; i++) {
        uint32_t shift = (uint32_t)(7 - i) * 4U;
        buf[i] = hex_digits[(val >> shift) & 0x0FU];
    }
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

    /* Fixed-width uppercase hex in w2, w1, w0 order - unique per chip. */
    u32_to_hex8(&g_serial_ascii[0], w2);
    u32_to_hex8(&g_serial_ascii[8], w1);
    u32_to_hex8(&g_serial_ascii[16], w0);
    g_serial_ascii[24] = '\0';

    g_serial_ready = true;
}

static char const *string_desc_arr[] = {
    (const char[]){0x09, 0x04}, /* English (0x0409) */
    "BobFlight",
#if defined(BF_F405_USB_DIAGNOSTIC)
    "BobFlight F405 USB test",
#else
    "BobFlight CDC",
#endif
    NULL, /* index 3 - filled from UID at runtime */
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
