# F405/F411 clock and register plans

**Isolated, test-only component, not an implemented F4 backend.** F4 entries remain planned and hardware selection still rejects them. No register writes, clock switching, startup, firmware flashing or physical bootloader verification are performed.

## Implemented interfaces

`bf_f4_make_clock_plan()` computes frequencies and requirements from an exact MCU part, HSE crystal frequency and supplied VDD. `bf_f4_make_clock_register_plan()` adds part-specific mask/value descriptions for PLL, bus prescaler, power-scale and flash-latency fields. Both reject invalid inputs without modifying caller output. A future part cannot inherit another part's voltage-scale encoding.

| Planned setting | STM32F405 | STM32F411 |
|---|---:|---:|
| PLL input | 1 MHz | 1 MHz |
| PLL N / P / Q | 336 / 2 / 7 | 384 / 4 / 8 |
| System / AHB | 168 MHz | 96 MHz |
| USB clock | 48 MHz | 48 MHz |
| APB1 / APB2 | 42 / 84 MHz | 48 / 96 MHz |
| Calculated APB1 / APB2 timer clocks | 84 / 168 MHz | 96 / 96 MHz |
| Flash wait states at 2.7..3.6 V | 5 | 3 |
| Regulator scale | Scale 1 | Scale 1 |

Accepted inputs are whole-MHz HSE crystals from 4 through 26 MHz and VDD from 2700 through 3600 mV. These are provided parameters, not measurements. Fractional-MHz sources and unknown parts are rejected rather than rounded or mapped to another MCU. Dividing before multiplying avoids 32-bit overflow. F411 uses 96 MHz so its main PLL simultaneously supplies exact 48 MHz USB. Actual oscillator tolerance, temperature, board supply and jitter are not qualified by this calculation.

## Register-field safeguards

- PLL mask `0x0f437fff` changes only M/N/P/Q and HSE-source fields. Reserved fields, including reset-state bit 29, are excluded.
- CFGR mask `0x0000fcf0` changes only AHB/APB prescalers. SYSCLK switch/status and MCO fields are excluded.
- F405 Scale 1 uses PWR mask/value `0x4000`; F411 uses `0xc000`. Logical scale 1 is not a portable register value.
- Flash mask `0x7` updates only latency, preserving cache/prefetch and other fields.
- Mask/value data describes selective updates, not whole-register replacement or an ordered initialization program. Tests exercise preservation of all bits outside each mask.
- No oscillator enable, PLL enable, PWR clock enable, readiness polling, SYSCLK switching or TIMPRE update is emitted.

## Source evidence

ST's PDF host timed out, so ST-authored documents were read from public mirrors. Hosting provenance and exact revisions are listed below, not presented as the newest available revisions. Source excerpts were checked directly, with independent research and code reviews.

| Document and host | Specific evidence used |
|---|---|
| [RM0090 Rev 19, February 2021, Santa Clara University mirror](https://www.cse.scu.edu/~dlewis/book3/docs/RM0090.pdf) | F405/F407-specific Table 10, p.80: 168 MHz, 5 WS at 2.7..3.6 V. PWR pp.141..142: single-bit Scale 1 and readiness. Chapter 7 pp.216..217 and 226..230: HSE/PLL, 168/42/84 MHz bus ceilings, timer doubling and register fields. The different F42x/F43x chapter is not used for F405. |
| [DS8626, DocID022152 Rev 2, January 2012, distributor mirror](https://elsitek.ru/upload/iblock/899/STM32F407ZGT6.pdf) | F405/F407 Table 28 p.86: crystal 4..26 MHz. Table 32 p.89: selected 1 MHz input and 336 MHz VCO within the listed PLL limits. This older revision is identified explicitly. |
| [RM0383, DocID026448 Rev 1, July 2014, Espruino mirror](https://www.espruino.com/datasheets/STM32F411xE_ref.pdf) | Table 5 p.44: 96 MHz requires 3 WS at 2.7..3.6 V. PWR pp.83..85: two-bit Scale 1, activation/readiness constraints. pp.90..91, 101..104 and 132: HSE, PLL, bus/timer formulas and fields. |
| [DS10314, DocID026289 Rev 7, December 2017, dronectl-hosted copy](https://raw.githubusercontent.com/dronectl/stm32f411-toolchain/master/docs/datasheet.pdf) | pp.19..20 and p.62 independently corroborate F411 AHB/APB2 100 MHz and APB1 50 MHz ceilings. Table 37 p.84 covers 4..26 MHz HSE. Table 57 p.104 contains the unresolved timer note described below. |
| Official ST CMSIS [F405](https://github.com/STMicroelectronics/cmsis-device-f4/blob/master/Include/stm32f405xx.h) and [F411](https://github.com/STMicroelectronics/cmsis-device-f4/blob/master/Include/stm32f411xe.h) headers | Directly checked PLL, CFGR, PWR and flash field masks. Both latency masks are three bits; VOS masks differ by part. |

ST permits the chosen 1 MHz PLL input but recommends 2 MHz for lower jitter. This deterministic whole-MHz implementation is not a jitter qualification. Supply/temperature grades, oscillator accuracy and applicable silicon errata must be reviewed for each future physical port.

### F411 document discrepancies are not silently ignored

RM0383 Rev 1 p.104 contains APB caution values inconsistent with its own p.91. DS10314 Rev 7 pp.20 and 62 independently corroborate the 50/100 MHz bus ceilings used here.

A separate discrepancy remains: DS10314 Rev 7 Table 57 footnote 3 on p.104 states a 50 MHz APB1 timer ceiling, while the manual's timer clock tree and the datasheet's other timer descriptions indicate higher timer clocks. The planner reports the frequency implied by the documented prescaler formula, **not approval to operate an APB1 timer at that frequency**. Resolve the applicable electrical limit using corrected/current ST documentation or manufacturer clarification before enabling hardware timers. This remains an explicit hardware-integration blocker.

For the selected F411 divisors (APB1 /2, APB2 /1), both documented TIMPRE modes yield the same calculated 96 MHz timer clocks. No TIMPRE change is needed for this narrow calculation; other divider combinations are not implemented.

## Sequencing constraints for a future backend

The returned structures must not be treated as a sequence of blind writes. In particular, F411 VOS must be programmed with PLL off, but the requested scale only becomes active with PLL on (RM0383 p.83). Do not copy F405's reset-state assumptions or wait for the requested F411 scale to become active while leaving PLL off.

A future implementation must keep a safe current system clock, disable the affected PLLs before changing their shared input fields, handle regulator readiness at the appropriate stage, increase and verify flash latency before increasing CPU frequency, prepare bus prescalers, wait for oscillator/PLL readiness, then verify the selected system-clock status. Changing PLLM/PLLSRC also constrains PLLI2S. Every wait needs a bounded deadline and a defined failure state; no unhealthy clock path may be reported ready. Lowering latency/frequency needs its own correctly ordered transition. These requirements are documented, not implemented by this PR.

## Regression evidence and boundaries

- 138 accepted input combinations, each checked for logical frequencies and register encoding/decoding.
- Invalid part/frequency/voltage, null-output and unchanged-output-on-failure checks cover both interfaces.
- Five old-register patterns exercise preservation outside each of four masks.
- Address/undefined-behavior sanitizer run and warning-clean native/Cortex-M4 object compilation passed.
- 142/142 native CTest checks passed after the register-plan addition.
- Independent static code review found no blocking implementation issue in the pure register planner.

No live F4 hardware backend, arming/failsafe, PID cadence, NVM schema, motor capability or flashing workflow is changed. No user rebuild is requested. Hardware startup, peripheral drivers, current errata review, recovery and physical `bl` validation remain separate work.

## Retrieved-reference fingerprints

SHA256 identifies the copies actually reviewed; it does not establish that a document is current:

- `f405-manual.pdf`: `630cdaa828b1230b7da2c1adf596fe3be8cbd9dca9a689fadc317167f4dec69f`
- `f405-datasheet.pdf`: `5508fdbd339f7e55402af87c28e25bf504a6face561257302b9d04f4557b6bde`
- `f411-rm0383.pdf`: `945c01b0e29aa12367e875eccf2996b1e5e74c297e7e83eff197132fd81cb1b9`
- `f411-datasheet.pdf`: `0d947b62647d309f77d71b9afb1f753abdab69a754fcdbacf6f3d5e7fa6e079f`
- `stm32f405xx.h`: `10c3b2dfc2b358d62a55668a7085ef07c44fc01abca8f2a08c2640a538040c7b`
- `stm32f411xe.h`: `37eb4283db7ea17197e6e2b4a855e87fb639c9ca8eaf4777aa389a096235013d`
