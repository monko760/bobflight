# TinyUSB provenance (BobFlight)

| Field | Value |
|-------|--------|
| Component | TinyUSB (device CDC + Synopsys DWC2) |
| Upstream | https://github.com/hathach/tinyusb |
| Release | 0.21.0 |
| SPDX | MIT |
| Tarball | https://github.com/hathach/tinyusb/archive/refs/tags/0.21.0.tar.gz |
| Tarball SHA-256 | `b7cdf35c5ccefb0f61640aff94a732ab4ebcb21498201e4a161545891b23ba01` |
| Tree | `third_party/tinyusb/` |

**Taken:** `src/` core, `device/`, `common/`, `osal/` headers, `class/cdc` device, `portable/synopsys/dwc2` device (`dcd_dwc2.c`, `dwc2_common.*`, `dwc2_type.h`, `dwc2_stm32.h`), root `LICENSE`, `version.yml`.

**Not taken:** host stack, other classes, other portables, `hw/` (ST Cube BSP), examples, tests, lib.

## BobFlight local patches (MIT-compatible)

| File | Change |
|------|--------|
| `src/portable/synopsys/dwc2/dwc2_common.c` | Bound GRSTCTL AHBIDL/CSRST waits in reset_core; return false on timeout so dwc2_core_init fails soft (cdc5). |
| `src/portable/synopsys/dwc2/dwc2_common.h` | Bound dfifo_flush_tx / dfifo_flush_rx GRSTCTL spin loops. |

