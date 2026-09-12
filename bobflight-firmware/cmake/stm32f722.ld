/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned STM32F722 linker script (typical 512 KB flash / 256 KB RAM).
 * Confirm on the exact part at bring-up. No board pins here.
 */
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 512K
  RAM   (rwx): ORIGIN = 0x20000000, LENGTH = 256K
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
    _sdata = .;
    *(.data*)
    _edata = .;
  } > RAM AT > FLASH

  .bss (NOLOAD) : {
    _sbss = .;
    *(.bss*)
    *(COMMON)
    _ebss = .;
    PROVIDE(end = .);
  } > RAM

  /* Sticky boot crumb survives Soft/HardFault; not BSS-cleared after Reset seed. */
  .noinit (NOLOAD) : {
    . = ALIGN(4);
    *(.noinit*)
    . = ALIGN(4);
  } > RAM

  ._user_heap_stack (NOLOAD) : {
    . = ALIGN(8);
    . = . + 0x400;
    . = ALIGN(8);
  } > RAM
}
