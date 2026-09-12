/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned STM32F745 linker script. DTCM holds normal data/stack; DMA buffers
 * are placed in the DMA-capable SRAM1/2 window.
 */
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1024K
  RAM   (rwx): ORIGIN = 0x20000000, LENGTH = 64K
  DMA_RAM (rwx): ORIGIN = 0x20010000, LENGTH = 256K
}
ENTRY(Reset_Handler)
_estack = ORIGIN(RAM) + LENGTH(RAM);
SECTIONS
{
  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
  .text : { *(.text*) *(.rodata*) KEEP(*(.init)) KEEP(*(.fini)) _etext = .; } > FLASH
  .ARM.exidx : { *(.ARM.exidx* .gnu.warning .ARM.extab*) } > FLASH
  _sidata = LOADADDR(.data);
  .data : { _sdata = .; *(.data*) _edata = .; } > RAM AT > FLASH
  .bss (NOLOAD) : { _sbss = .; *(.bss*) *(COMMON) _ebss = .; PROVIDE(end = .); } > RAM
  .noinit (NOLOAD) : { . = ALIGN(4); *(.noinit*) . = ALIGN(4); } > RAM
  .dma (NOLOAD) : { . = ALIGN(32); *(.dma*) . = ALIGN(32); } > DMA_RAM
  ._user_heap_stack (NOLOAD) : { . = ALIGN(8); . = . + 0x400; . = ALIGN(8); } > RAM
}