/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "hal/stm32f7/bootloader_policy.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static void test_cookie_consume(void) {
    bl_cookie_t cookie;

    /* 1. Valid paired cookie with software reset consumed once */
    cookie.magic = BL_MAGIC;
    cookie.inverse = ~BL_MAGIC;
    assert(bl_cookie_consume(&cookie, BL_SOFTWARE_RESET) == true);
    assert(cookie.magic == 0);
    assert(cookie.inverse == 0);

    /* Consumed once: second consume attempt must fail */
    assert(bl_cookie_consume(&cookie, BL_SOFTWARE_RESET) == false);

    /* 2. Invalid / missing / inverse mismatch */
    /* Missing magic & inverse */
    cookie.magic = 0;
    cookie.inverse = 0;
    assert(bl_cookie_consume(&cookie, BL_SOFTWARE_RESET) == false);

    /* Valid magic, invalid inverse */
    cookie.magic = BL_MAGIC;
    cookie.inverse = 0x12345678u;
    assert(bl_cookie_consume(&cookie, BL_SOFTWARE_RESET) == false);
    assert(cookie.magic == 0 && cookie.inverse == 0);

    /* Invalid magic, valid inverse */
    cookie.magic = 0x12345678u;
    cookie.inverse = ~BL_MAGIC;
    assert(bl_cookie_consume(&cookie, BL_SOFTWARE_RESET) == false);
    assert(cookie.magic == 0 && cookie.inverse == 0);

    /* Valid cookie but missing BL_SOFTWARE_RESET in cause */
    cookie.magic = BL_MAGIC;
    cookie.inverse = ~BL_MAGIC;
    assert(bl_cookie_consume(&cookie, 0) == false);
    assert(cookie.magic == 0 && cookie.inverse == 0);

    /* 3. Excluded reset causes: Power (bit 27), BOR (bit 25), Watchdog (bits 29, 30), LPWR (bit 31) */
    const uint32_t bad_bits[] = {1u << 25, 1u << 27, 1u << 29, 1u << 30, 1u << 31};
    for (size_t i = 0; i < sizeof(bad_bits) / sizeof(bad_bits[0]); i++) {
        cookie.magic = BL_MAGIC;
        cookie.inverse = ~BL_MAGIC;
        uint32_t cause = BL_SOFTWARE_RESET | bad_bits[i];
        assert(bl_cookie_consume(&cookie, cause) == false);
        assert(cookie.magic == 0 && cookie.inverse == 0);
    }

    /* 4. PINRST bit (bit 26) alongside SFTRST allowed */
    cookie.magic = BL_MAGIC;
    cookie.inverse = ~BL_MAGIC;
    uint32_t cause_pinrst = BL_SOFTWARE_RESET | (1u << 26);
    assert(bl_cookie_consume(&cookie, cause_pinrst) == true);
    assert(cookie.magic == 0 && cookie.inverse == 0);
}

static void test_vectors_valid(void) {
    const uint32_t f722_ram_end = 0x20040000u;
    const uint32_t f745_ram_end = 0x20050000u;

    /* Valid vectors for F722 */
    assert(bl_vectors_valid(0x20010000u, BL_ROM_BASE + 1u, f722_ram_end) == true);
    assert(bl_vectors_valid(f722_ram_end, BL_ROM_END - 2u + 1u, f722_ram_end) == true);

    /* Valid vectors for F745 */
    assert(bl_vectors_valid(0x20048000u, BL_ROM_BASE + 0x100u + 1u, f745_ram_end) == true);
    assert(bl_vectors_valid(f745_ram_end, BL_ROM_BASE + 1u, f745_ram_end) == true);

    /* SP bound checks: sp <= 0x20000000u invalid */
    assert(bl_vectors_valid(0x20000000u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x1FFFFFFFu, BL_ROM_BASE + 1u, f722_ram_end) == false);

    /* SP bound checks: sp > ram_end invalid */
    assert(bl_vectors_valid(f722_ram_end + 4u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(f745_ram_end + 4u, BL_ROM_BASE + 1u, f745_ram_end) == false);
    assert(bl_vectors_valid(0x20048000u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20048000u, BL_ROM_BASE + 1u, f745_ram_end) == true);

    /* SP 8-byte alignment checks: sp & 7 != 0 invalid */
    assert(bl_vectors_valid(0x20010004u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010002u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010001u, BL_ROM_BASE + 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010008u, BL_ROM_BASE + 1u, f722_ram_end) == true);

    /* PC Thumb bit checks: pc & 1 == 0 invalid (even PC) */
    assert(bl_vectors_valid(0x20010000u, BL_ROM_BASE, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010000u, BL_ROM_BASE + 0x20u, f722_ram_end) == false);

    /* PC ROM bounds checks: pc < BL_ROM_BASE or pc >= BL_ROM_END invalid */
    assert(bl_vectors_valid(0x20010000u, (BL_ROM_BASE - 2u) | 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010000u, 0x08000001u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010000u, BL_ROM_END | 1u, f722_ram_end) == false);
    assert(bl_vectors_valid(0x20010000u, (BL_ROM_END + 0x100u) | 1u, f722_ram_end) == false);

    /* Valid ROM PC bounds boundaries */
    assert(bl_vectors_valid(0x20010000u, BL_ROM_BASE | 1u, f722_ram_end) == true);
    assert(bl_vectors_valid(0x20010000u, (BL_ROM_END - 2u) | 1u, f722_ram_end) == true);
}

int main(void) {
    test_cookie_consume();
    test_vectors_valid();
    puts("PASS host_bootloader_policy");
    return 0;
}
