# STM32F4 Cold-Reset Clock Bring-up (`bf_f4_clock_start`)

**Bounded backend slice component, not an enabled F4 hardware target.** This module implements hardware-isolated cold-reset clock bring-up for STM32F405 and STM32F411 microcontrollers using injected MMIO register callbacks. It builds upon validated register plans from `clock_plan.{h,c}` and executes a strictly ordered hardware initialization sequence.

For the connected F405xG reset-to-MMIO fixture, see [F405 register adapter](f405-clock-mmio.md). F411 retains callback/model coverage only; no hardware target is enabled.

---

## Architecture & Interfaces

### 1. Register Enumeration (`bf_f4_clock_reg_t`)
Hardware register access is decoupled from MMIO memory locations via an explicit register enum:

```c
typedef enum {
    BF_F4_CLOCK_REG_RCC_CR = 0,
    BF_F4_CLOCK_REG_RCC_PLLCFGR,
    BF_F4_CLOCK_REG_RCC_CFGR,
    BF_F4_CLOCK_REG_RCC_APB1ENR,
    BF_F4_CLOCK_REG_PWR_CR,
    BF_F4_CLOCK_REG_PWR_CSR,
    BF_F4_CLOCK_REG_FLASH_ACR,
    BF_F4_CLOCK_REG_COUNT
} bf_f4_clock_reg_t;
```

### 2. Callback Prototypes & Function Signature
Register access uses user-supplied callback functions:

```c
typedef bool (*bf_f4_clock_read_fn)(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t *val);
typedef bool (*bf_f4_clock_write_fn)(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t val);

bf_f4_clock_start_status_t bf_f4_clock_start(
    bf_f4_part_t part,
    uint32_t hse_hz,
    uint32_t vdd_mv,
    uint32_t poll_budget,
    bf_f4_clock_read_fn read_fn,
    bf_f4_clock_write_fn write_fn,
    void *user_ctx,
    bf_f4_clock_plan_t *out_clocks
);
```

### 3. Status Codes & Error Diagnostics
Execution results return an explicit status enum:

| Status Code | Description | Post-Switch Failure? |
|---|---|---|
| `BF_F4_CLOCK_START_OK` | Clock bring-up succeeded; `out_clocks` populated. | No |
| `BF_F4_CLOCK_START_ERR_INVALID_PARAM` | Null pointers, zero poll budget, or unsupported clock plan. | No |
| `BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE` | Initial state failed cold-reset requirements before writes. | No |
| `BF_F4_CLOCK_START_ERR_CALLBACK_FAILED` | Pre-switch register read or write callback returned false. | No |
| `BF_F4_CLOCK_START_ERR_WRITE_CHECK_FAILED` | Pre-switch register write verification / mask check failed. | No |
| `BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT` | FLASH_ACR latency readback check failed. | No |
| `BF_F4_CLOCK_START_ERR_HSE_TIMEOUT` | Exceeded `poll_budget` waiting for `HSERDY`. | No |
| `BF_F4_CLOCK_START_ERR_PLL_TIMEOUT` | Exceeded `poll_budget` waiting for `PLLRDY`. | No |
| `BF_F4_CLOCK_START_ERR_VOS_TIMEOUT` | Exceeded `poll_budget` waiting for regulator `VOSRDY`. | No |
| `BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT` | Exceeded `poll_budget` verifying `SWS == PLL`. | **Yes (Uncertain)** |
| `BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED` | Callback failure during/after SYSCLK switch write or SWS poll. | **Yes (Uncertain)** |
| `BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED` | Write verification check failed immediately following SYSCLK switch. | **Yes (Uncertain)** |

---

## Safety & Pre-condition Rules

Before performing any register writes, `bf_f4_clock_start()` validates all parameters and evaluates initial hardware state:

1. **Parameter Validation:**
   - `read_fn`, `write_fn`, and `out_clocks` must be non-NULL.
   - `poll_budget` must be greater than zero.
   - `bf_f4_make_clock_register_plan()` must validate `part`, `hse_hz`, and `vdd_mv`.

2. **Unsafe Initial State Rejection:**
   - **HSI Active & Ready:** `RCC_CR` bits `HSION` (bit 0) and `HSIRDY` (bit 1) must be set.
   - **SYSCLK Target & Status:** `RCC_CFGR` target `SW[1:0]` (bits 1:0) AND status `SWS[1:0]` (bits 3:2) must both equal `00` (HSI). Live-clock reconfigurations or pending switch requests (`SW != 00`) are strictly rejected before any register writes.
   - **PLL Inactive:** `RCC_CR` bits `PLLON` (bit 24), `PLLRDY` (bit 25), `PLLI2SON` (bit 26), and `PLLI2SRDY` (bit 27) must all be zero. Active shared PLL inputs are never modified.
   - **HSE Bypass:** `RCC_CR` bit `HSEBYP` (bit 18) must be zero (crystal oscillator mode required).

---

## Ordered Bring-Up Sequence

1. **Power Interface Clock Enable:**
   - Read `RCC_APB1ENR`, set bit 28 (`PWREN`), write back and verify bit 28 is set.
2. **Regulator Voltage Scale (VOS):**
   - Read `PWR_CR`, update VOS field (`0x4000` for F405 Scale 1; `0xc000` for F411 Scale 1), write back and verify mask preservation.
3. **FLASH Wait States (Latency Increase Before Speedup):**
   - Read `FLASH_ACR`, set LATENCY bits `0..2` (`5` for F405 at 168 MHz; `3` for F411 at 96 MHz), write back and readback verify matching latency bits.
4. **Bus Prescalers & PLL Configuration (While PLL is OFF):**
   - Program `RCC_CFGR` bus prescalers (AHB /1, APB1 /4 or /2, APB2 /2 or /1) preserving SYSCLK switch fields.
   - Program `RCC_PLLCFGR` M, N, P, Q dividers and `PLLSRC = HSE` while main PLL remains off.
5. **HSE Enable & Readiness:**
   - Set `HSEON` (bit 16) in `RCC_CR`. Poll `HSERDY` (bit 17) up to `poll_budget` iterations.
6. **PLL Enable & Readiness:**
   - Set `PLLON` (bit 24) in `RCC_CR`. Poll `PLLRDY` (bit 25) up to `poll_budget` iterations.
7. **Voltage Regulator Readiness Phase:**
   - Poll `PWR_CSR` bit 14 (`VOSRDY`) up to `poll_budget` iterations. (F411 VOS is configured with PLL off but becomes effective post-PLL activation).
8. **SYSCLK Switch & Verification:**
   - Update `RCC_CFGR` `SW[1:0]` bits to `10` (PLL). Perform write-check verification and poll `RCC_CFGR` `SWS[1:0]` (bits 3:2) up to `poll_budget` iterations until `SWS == 10` (PLL).
9. **Final Output Population:**
   - Populate caller's `*out_clocks` with validated frequencies ONLY after complete sequence success.

---

## Error Model & Caller Constraints

- **Output Invariance on Failure:** If any step fails, `out_clocks` is left completely unchanged (caller's sentinel values preserved).
- **Distinguishing Post-Switch Failures:**
  - Query helper `bf_f4_clock_start_status_is_post_switch(status)` returns `true` for all errors occurring during or after the SYSCLK switch write attempt (`BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT`, `BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED`, `BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED`).
  - When `is_post_switch` returns `true`, the system clock state is uncertain and caller MUST NOT assume safe system operation or attempt peripheral initialization.
  - **IMPORTANT SAFETY NOTE:** Returning `false` DOES NOT prove or guarantee that the system is running safely on HSI. A false return occurs on invalid parameters, initial state/read check failures (where hardware state was unsafe or unknown), or pre-switch configuration failures after partial register modifications.

---

## Test & Verification Evidence

Host regression test `tests/host_f4_clock_start.c` covers the modeled startup scenarios using simulated register state and write logs:

1. **F405 & F411 Full Bring-up:** Verifies full sequence, frequency struct output, control write order, and bit mask preservation.
2. **Invalid Inputs & Null Callbacks:** Confirms output preservation and zero register writes on invalid inputs.
3. **Unsafe Starting States:** Verifies rejection of non-HSI `SW` or `SWS` (including pending `SW` variants), active PLL/PLLI2S, missing `HSIRDY`, or set `HSEBYP`.
4. **FLASH Readback Rejection:** Verifies failure handling when FLASH latency write is rejected.
5. **Readiness Timeouts:** Exercises `HSERDY`, `PLLRDY`, `VOSRDY`, and `SWS` polling budget exhaustion.
6. **Post-Switch Fault Injection:** Exercises SYSCLK switch write failure before/after side effect, readback failure/mismatch, and SWS poll read failure.
7. **Output Preservation:** Confirms caller `*out_clocks` sentinel remains unmodified across all failure modes.
8. **Mask Preservation:** Validates that unrelated register bits outside specified masks remain intact.

---

## Build and integration boundaries

The `f4_clock_start` CTest target compiles the clock planner, clock-start component and host fault-injection harness with assertions enabled. The separate CI job compiles both components as Cortex-M4 hard-float objects. Neither path links a hardware firmware image or supplies a physical register-access adapter.

A future adapter must implement the enumerated registers for the exact MCU and must accurately report read/write failures. Clock startup requires exclusive reset-time access, without concurrent clock writers and before clock-dependent consumers/peripherals are initialized. Initial register checks do not prove every peripheral is reset. Poll budgets count callback reads, not milliseconds, and callbacks themselves must return in bounded time.

On any failure, do not initialize peripherals from requested frequencies. There is no automatic rollback or claimed safe fallback, and unchanged output is not a measurement of current clocks. A failed write callback can have side effects. See [broader support gates](broader-mcu-support.md) and [part-specific clock evidence](f4-clock-plans.md).

This component remains excluded from hardware backend selection. F411 timer electrical limits, startup/vector/linker work, physical USB, persistent settings and bootloader recovery remain separate integration gates. No user rebuild or hardware flash is requested.
