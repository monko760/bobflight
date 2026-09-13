/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned STM32F722 linker script: 512 KiB flash; 64 KiB DTCM for
 * data/stack, 192 KiB SRAM1/2 for explicit DMA buffers. No config storage yet.
 */
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 512K
  RAM   (rwx): ORIGIN = 0x20000000, LENGTH = 64K
  DMA_RAM (rwx): ORIGIN = 0x20010000, LENGTH = 192K
}

ENTRY(Reset_Handler)

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
  .isr_vector : {
    KEEP(*(.isr_vector))
  } > FLASH

  .text : {
    *(.text*)
    *(.rodata*)
    KEEP(*(.init))
    KEEP(*(.fini))
    _etext = .;
  } > FLASH

  .ARM.exidx : { *(.ARM.exidx* .gnu.warning .ARM.extab*) } > FLASH

  _sidata = LOADADDR(.data);

  .data : {
    . = ALIGN(4);
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH

  .bss (NOLOAD) : {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
    PROVIDE(end = .);
  } > RAM

  /* Sticky boot crumb survives Soft/HardFault; not BSS-cleared after Reset seed. */
  .noinit (NOLOAD) : {
    . = ALIGN(4);
    *(.noinit*)
    . = ALIGN(4);
  } > RAM

  .dma (NOLOAD) : { . = ALIGN(32); *(.dma*) . = ALIGN(32); } > DMA_RAM

  ._user_heap_stack (NOLOAD) : {
    . = ALIGN(8);
    . = . + 0x400; /* minimum heap reservation */
    . = ALIGN(8);
    _ram_used_end = .;
  } > RAM
}
ASSERT(_ram_used_end + 8192 <= _estack, "F722 data leaves less than 8 KiB stack headroom")
ASSERT(LOADADDR(.data) + SIZEOF(.data) <= 0x08080000, "F722 image exceeds 512 KiB flash")
