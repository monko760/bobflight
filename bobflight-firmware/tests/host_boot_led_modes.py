#!/usr/bin/env python3
"""Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0.
Preprocess actual MCU paths with a host compiler; no assembly or timing claim.
Checks live function bodies under the default/OFF/ON option matrix.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CC = sys.argv[1] if len(sys.argv) > 1 else "cc"


def preprocess(path, diagnostic, prove):
    args = [CC, "-E", "-P", "-std=c11", "-I", str(ROOT / "include"),
            "-I", str(ROOT / "src")]
    for name, value in [("BOBFLIGHT_BOOT_LED_DIAGNOSTICS", diagnostic),
                        ("BOBFLIGHT_PROVE_RESET", prove)]:
        if value is not None:
            args.append(f"-D{name}={value}")
    return subprocess.check_output(args + [str(ROOT / path)], text=True)


def body(text, name, required=True):
    match = re.search(r"\b" + re.escape(name) + r"\s*\([^;{}]*\)\s*\{", text)
    if not match:
        assert not required, f"missing function {name}"
        return None
    start = match.end()
    depth = 1
    for end in range(start, len(text)):
        if text[end] == "{":
            depth += 1
        elif text[end] == "}":
            depth -= 1
        if depth == 0:
            return re.sub(r"\s+", "", text[start:end])
    raise AssertionError(f"unclosed function {name}")


def check(diagnostic, prove):
    startup = preprocess("src/hal/stm32f7/startup_stm32f722.c", diagnostic, prove)
    main = preprocess("src/app/main.c", diagnostic, prove)
    init = preprocess("src/app/init.c", diagnostic, prove)
    reset = body(startup, "Reset_Handler")
    app = body(init, "app_init")
    entry = body(main, "main")
    fault = body(startup, "HardFault_Handler")
    assert "early_nop_busywait(" in fault and "g_boot_crumb" in fault
    assert "0xE000ED88" in reset and "0xE000ED08" in reset and "0x08000000u" in reset
    assert "g_boot_crumb=0u;" in reset
    assert "boot_crumb_set(1u);" in entry
    for stage in range(2, 8):
        assert f"boot_crumb_set({stage}u);" in app
    assert "boot_led_init();" in app
    led_init = body(init, "boot_led_init")
    assert "hal_gpio_init(led,HAL_GPIO_OUT);" in led_init
    assert "board_mmio_permitted()" in led_init and "hal_pin_valid(led)" in led_init
    assert "busywait" not in led_init
    heartbeat = body(main, "main_led_heartbeat_tick")
    assert "hal_millis()" in heartbeat and "busywait" not in heartbeat
    assert "boot_busywait_ms(20u);" in app and "boot_busywait_ms(5u);" in app
    assert app.index("hal_clock_init(") < app.index("hal_usb_cdc_init(")
    assert app.index("hal_usb_cdc_init(") < app.index("motor_safe_idle(")
    assert ("prove_reset_pa2_forever();" in reset) == bool(prove)
    assert ("main();" in reset) == (not bool(prove))
    assert ("early_pa2_blink();" in reset) == (bool(diagnostic) and not prove)
    assert (body(startup, "early_pa2_blink", False) is not None) == (bool(diagnostic) and not prove)
    assert ("boot_pa2_crude_short_pulse();" in entry) == bool(diagnostic)
    assert (body(startup, "boot_pa2_crude_short_pulse", False) is not None) == bool(diagnostic)
    for name in ["boot_led_crumb", "boot_led_heartbeat", "boot_led_usb_chirp"]:
        assert (f"{name}();" in app) == bool(diagnostic)
        assert (body(init, name, False) is not None) == bool(diagnostic)
    assert (body(init, "boot_led_pulses", False) is not None) == bool(diagnostic)
    if diagnostic:
        assert "boot_busywait_ms(1000u);" in body(init, "boot_led_heartbeat")
    print(f"PASS diagnostics={diagnostic!s} prove_reset={prove!s}")


for diagnostic in (None, 0, 1):
    for prove in (None, 0, 1):
        check(diagnostic, prove)
print("PASS: 9 MCU preprocessing modes; success patterns isolated, fault/stage/USB settle paths retained")
