/* SPDX-License-Identifier: Apache-2.0
 * Integer-only policy, safe before C data/BSS initialization.
 * ST AN2606 Rev61 table177: F72/F74 ROM 0x1FF00000..0x1FF0EDBF.
 */
#ifndef BOBFLIGHT_BOOTLOADER_POLICY_H
#define BOBFLIGHT_BOOTLOADER_POLICY_H
#include <stdbool.h>
#include <stdint.h>
#define BL_ROM_BASE 0x1FF00000u
#define BL_ROM_END 0x1FF0EDC0u
#define BL_MAGIC 0x424C524Fu
#define BL_SOFTWARE_RESET (1u<<28)
typedef struct {uint32_t magic,inverse;} bl_cookie_t;
static inline bool bl_cookie_consume(volatile bl_cookie_t *cookie,uint32_t cause){
 bool valid=cookie->magic==BL_MAGIC&&cookie->inverse==~BL_MAGIC;
 cookie->magic=0;cookie->inverse=0;
 /* PINRSTF is not a reliable exclusion: it may accompany system reset.
  * Clear sticky flags BEFORE requesting reset; reject power/watchdog causes. */
 uint32_t bad=(1u<<25)|(1u<<27)|(1u<<29)|(1u<<30)|(1u<<31);
 return valid&&(cause&BL_SOFTWARE_RESET)&&!(cause&bad);
}
static inline bool bl_vectors_valid(uint32_t sp,uint32_t pc,uint32_t ram_end){
 return sp>0x20000000u&&sp<=ram_end&&!(sp&7u)&&(pc&1u)&&
        (pc&~1u)>=BL_ROM_BASE&&(pc&~1u)<BL_ROM_END;
}
#endif
