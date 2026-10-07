/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */

_estack = ORIGIN(RAM) + LENGTH(RAM);
SECTIONS {
  .isr_vector ORIGIN(FLASH) : { KEEP(*(.isr_vector)) } > FLASH
  .text : { *(.text .text.*) *(.rodata .rodata.*) *(.glue_7 .glue_7t) } > FLASH
  .ARM.extab : { *(.ARM.extab*) } > FLASH
  .ARM.exidx : { *(.ARM.exidx*) } > FLASH
  .data : {
    . = ALIGN(4); _sdata = .; *(.data .data.*) . = ALIGN(4); _edata = .;
  } > RAM AT > FLASH
  _sidata = LOADADDR(.data);
  .bss (NOLOAD) : {
    . = ALIGN(4); _sbss = .; *(.bss .bss.*) *(COMMON) . = ALIGN(4); _ebss = .;
  } > RAM
  .dma_bss ALIGN(32) (NOLOAD) : {
    _sdma_bss = .; *(.dma_bss .dma_bss.*) . = ALIGN(4); _edma_bss = .;
  } > RAM
  .noinit (NOLOAD) : {
    . = ALIGN(4); *(.noinit .noinit.*) . = ALIGN(4);
  } > RAM
  .heap_reservation (NOLOAD) : { . = ALIGN(8); . += 1024; _ram_used_end = .; } > RAM
  /* CPU-only uninitialized scratch. No implicit zeroing, DMA or initialized data. */
  .ccm_noinit (NOLOAD) : { . = ALIGN(4); *(.ccm_noinit .ccm_noinit.*) . = ALIGN(4); } > CCM
  .unsupported_stubs : { KEEP(*(.vfp11_veneer .v4_bx .iplt .rel.iplt .igot.plt)) } > FLASH
  .ARM.attributes 0 : { *(.ARM.attributes) }
  /DISCARD/ : { *(.comment) *(.note.GNU-stack) }
}
ASSERT(bf_f4_component_part == __bf_expected_part, "F4 startup/linker part mismatch")
ASSERT(SIZEOF(.isr_vector) == __bf_vector_bytes, "Wrong F4 vector table size")
ASSERT((ADDR(.isr_vector) & 511) == 0, "Vector table must be 512-byte aligned")
ASSERT((_estack & 7) == 0, "MSP must be 8-byte aligned")
ASSERT(_ram_used_end + 8192 <= _estack, "F4 RAM leaves less than 8 KiB stack headroom")
ASSERT(LOADADDR(.data) + SIZEOF(.data) <= __bf_nvm_a, "F4 image overlaps reserved settings sectors")
ASSERT(ORIGIN(FLASH) + LENGTH(FLASH) == __bf_nvm_a, "F4 application flash boundary mismatch")
ASSERT(__bf_nvm_b + __bf_nvm_sector_bytes == __bf_flash_end, "F4 NVM geometry mismatch")
ASSERT(SIZEOF(.ccm_noinit) <= LENGTH(CCM), "CCM unavailable or overflow")
ASSERT(SIZEOF(.unsupported_stubs) == 0, "Unexpected dynamic or legacy ARM stubs")
