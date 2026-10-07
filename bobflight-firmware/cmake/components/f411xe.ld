/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Exact-density component layout. Not a production board linker. */
ENTRY(Reset_Handler)
MEMORY {
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 256K
  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
  CCM (rw) : ORIGIN = 0x10000000, LENGTH = 0K
}
__bf_expected_part = 411;
__bf_vector_bytes = 408;
__bf_nvm_a = 0x08040000;
__bf_nvm_b = 0x08060000;
__bf_flash_end = 0x08080000;
__bf_nvm_sector_bytes = 0x20000;
INCLUDE f4-component-sections.ld
