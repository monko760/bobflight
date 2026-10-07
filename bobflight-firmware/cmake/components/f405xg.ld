/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Exact-density component layout. Not a production board linker. */
ENTRY(Reset_Handler)
MEMORY {
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 768K
  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
  CCM (rw) : ORIGIN = 0x10000000, LENGTH = 64K
}
__bf_expected_part = 405;
__bf_vector_bytes = 392;
__bf_nvm_a = 0x080c0000;
__bf_nvm_b = 0x080e0000;
__bf_flash_end = 0x08100000;
__bf_nvm_sector_bytes = 0x20000;
INCLUDE f4-component-sections.ld
