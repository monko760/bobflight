#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Board definition schema validator: every checked-in board passes; malformed,
incomplete and conflicting definitions are rejected with the specific error."""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import board_def  # noqa: E402
from board_def import BoardDefError, parse_yaml, validate  # noqa: E402

KAKUTE = (ROOT / "boards/kakute_f7_hdv.yaml").read_text()
MATEK = (ROOT / "boards/matek_f722_px.yaml").read_text()


def check(raw, stem="kakute_f7_hdv"):
    return validate(parse_yaml(raw), stem)


REJECTS_DIR = Path(__file__).resolve().parent / "board_schema_rejects"
CONTROLS_DIR = Path(__file__).resolve().parent / "board_schema_controls"
# QA corpus: file -> the error it must raise (not merely "some" BoardDefError).
REJECTS = {
    "NO_uppercase_norway.yaml": r"ambiguous scalar 'NO'",
    "absent_gyro_on_dev_board.yaml": r"physical board requires a gyro block",
    "absent_motors_list.yaml": r"^motors: required field missing or absent",
    "absent_required_board_id.yaml": r"^board_id: required field missing or absent",
    "absent_required_display_name.yaml": r"^display_name: required field missing or absent",
    "absent_required_gyro_cs.yaml": r"^gyro\.cs: required field missing or absent",
    "alias_value.yaml": r"unsupported scalar '\*gyro_cs'",
    "anchor_alias.yaml": r"unsupported scalar '&a",
    "bad_indent.yaml": r"line 31: bad indentation",
    "block_scalar_pipe.yaml": r"unsupported scalar '\|'",
    "bom_prefix.yaml": r"line 1: expected `key: value`",
    "build_label_huge.yaml": r"configurator\.build_label: string too long",
    "channel_0.yaml": r"TIM1 has no channel 0",
    "comments_only.yaml": r"empty board definition",
    "display_name_C_injection.yaml": r"quotes/backslashes not allowed inside strings",
    "display_name_empty_quotes.yaml": r"display_name: empty or quoted 'absent' string",
    "display_name_with_quote_injection.yaml": r"unsupported scalar 'Kakute \"F7\"'",
    "dma_clash_same_stream.yaml": r"duplicate DMA stream DMA1_S2",
    "dma_garbage_value.yaml": r"dma 'banana' must look like DMA1_S2",
    "doc_separator.yaml": r"line 1: expected `key: value`",
    "dup_key_flow.yaml": r"duplicate key: vbat",
    "dup_key_top.yaml": r"line 62: duplicate key: baro",
    "dup_pin_gyro_cs_eq_sd_cs.yaml": r"duplicate pin PE4: gyro\.cs and sd\.cs",
    "dup_pin_leading_zero_PA09.yaml": r"led\.led0: invalid pin 'PA09'",
    "dup_pin_leading_zero_PB00_motor.yaml": r"motors\[1\]\.pin: invalid pin 'PB00'",
    "dup_pin_motor_vs_led.yaml": r"duplicate pin PB0",
    "dup_pin_uart_vs_motor.yaml": r"duplicate pin PB0: motors\[1\] and uart4\.tx",
    "dup_pin_usb_dm_vs_uart.yaml": r"duplicate pin PA9: usb\.dm and uart1\.tx",
    "dup_timer_channel.yaml": r"duplicate timer use TIM3 CH3",
    "empty_file.yaml": r"empty board definition",
    "float_8_0.yaml": r"ambiguous scalar '8\.0'",
    "gyro_chip_unknown.yaml": r"gyro\.chip: 'FOO9000' not one of",
    "hex_0x8.yaml": r"mcu\.hse_mhz: expected non-negative integer",
    "image_profile_diag_on_main.yaml": r"image_profile must match support",
    "linker_script_missing_file.yaml": r"linker_script 'cmake/nope\.ld' does not exist",
    "linker_script_path_traversal.yaml": r"linker_script '\.\./\.\./\.\./etc/passwd' must be a cmake/\*\.ld path",
    "mcu_target_unknown.yaml": r"mcu\.target 'stm32h999' is not a known MCU target",
    "menu_order_on_main_board.yaml": r"menu_order applies to diagnostic profiles only",
    "merge_key.yaml": r"line 47: expected `key: value`",
    "missing_key_gyro_orientation.yaml": r"gyro\.orientation: required field missing",
    "missing_key_status.yaml": r"^status: required field missing",
    "motor_index_gap.yaml": r"motors must be indexed 1\.\.N",
    "motor_output_true_no_motors.yaml": r"motor_output requires motors",
    "negative_int.yaml": r"mcu\.hse_mhz: expected non-negative integer",
    "null_tilde.yaml": r"ambiguous scalar '~'",
    "octal_0o10.yaml": r"mcu\.hse_mhz: expected non-negative integer",
    "octal_hse_010.yaml": r"ambiguous scalar '010' \(leading zero\)",
    "on_bool.yaml": r"ambiguous scalar 'on'",
    "out_of_range_hse_0.yaml": r"hse_mhz 0 outside 4\.\.26",
    "out_of_range_hse_999.yaml": r"hse_mhz 999 outside 4\.\.26",
    "out_of_range_pin_PA16.yaml": r"invalid pin 'PA16'",
    "out_of_range_uart_9.yaml": r"uart 9 does not exist on STM32F745",
    "pin_port_K_on_F722.yaml": r"PK2 is on port K, which STM32F722 does not have",
    "protocol_unknown.yaml": r"receiver\.protocol: 'BANANA' not one of",
    "quoted_absent_gyro_chip.yaml": r"gyro\.chip: 'absent' not one of",
    "receiver_uart_not_in_table.yaml": r"receiver\.uart 5 is not in the uarts table",
    "schema_version_2.yaml": r"unsupported schema_version",
    "sd_logging_true_no_sd.yaml": r"sd_logging requires an sd block",
    "sexagesimal_1_30.yaml": r"ambiguous scalar '1:30'",
    "spi_bus_0.yaml": r"gyro\.spi_bus 0 does not exist",
    "spi_bus_99.yaml": r"gyro\.spi_bus 99 does not exist",
    "spi_same_bus_gyro_sd.yaml": r"duplicate SPI bus 4: gyro and sd",
    "tab_indent.yaml": r"tabs are not allowed",
    "timer_TIM14_ch4_nonexistent.yaml": r"TIM14 has no channel 4",
    "timer_TIM15_not_allowed.yaml": r"motors\[3\]\.timer invalid",
    "timer_channel_TIM01_alias.yaml": r"motors\[2\]\.timer invalid",
    "trailing_garbage_after_pin.yaml": r"gyro\.cs: invalid pin 'PE4 PE5'",
    "two_docs.yaml": r"line 62: expected `key: value`",
    "unknown_motor_key.yaml": r"unknown field 'inverted'",
    "unknown_nested_key_typo.yaml": r"gyro: unknown field 'ext1'",
    "unknown_top_key_typo.yaml": r"unknown top-level field 'beepr'",
    "usb_cdc_mismatch.yaml": r"usb\.cdc must equal capabilities\.usb_cdc",
    "wrong_type_bool_True.yaml": r"ambiguous scalar 'True'",
    "wrong_type_caps_string.yaml": r"capabilities: expected mapping",
    "wrong_type_quoted_int.yaml": r"gyro\.spi_bus: expected non-negative integer",
    "wrong_type_spi_bus_str.yaml": r"gyro\.spi_bus: expected non-negative integer",
    "yes_bool.yaml": r"ambiguous scalar 'yes'",
}
# Accepted on purpose. CRLF and uart 7/8 on F745 are valid. PK7 on the Kakute's F745 is a
# known gap: the F745 has port K in its largest package, and rejecting it needs the board's
# package (LQFP100 vs LQFP176), which the schema does not carry and we have not verified.
CONTROLS = ("crlf_line_endings.yaml", "uart_on_F722_8_but_F745_has8.yaml", "pin_port_J_on_F745_LQFP100.yaml")


def full(raw, stem="kakute_f7_hdv", root=ROOT):
    return board_def.check_tree(validate(parse_yaml(raw), stem), root)


class Schema(unittest.TestCase):
    def test_all_checked_in_boards_valid(self):
        files = board_def.board_files(ROOT)
        self.assertGreaterEqual(len(files), 6)
        for p in files:
            with self.subTest(p.name):
                d = board_def.load(p)
                self.assertEqual(d["board_id"], p.stem)
                self.assertTrue(p.read_text().startswith("# SPDX-License-Identifier: Apache-2.0"))

    def bad(self, raw, rx, stem="kakute_f7_hdv"):
        with self.assertRaisesRegex(BoardDefError, rx):
            full(raw, stem)

    def drop_line(self, raw, prefix):
        lines = raw.splitlines(keepends=True)
        i = next(i for i, l in enumerate(lines) if l.startswith(prefix))
        return "".join(lines[:i] + lines[i + 1:])

    def test_qa_corpus_rejected_with_specific_error(self):
        files = sorted(p.name for p in REJECTS_DIR.glob("*.yaml"))
        self.assertEqual(files, sorted(REJECTS))
        for name, rx in REJECTS.items():
            with self.subTest(name):
                raw = (REJECTS_DIR / name).read_bytes().decode("utf-8")
                with self.assertRaisesRegex(BoardDefError, rx):
                    full(raw, None)

    def test_qa_controls_accepted(self):
        for name in CONTROLS:
            with self.subTest(name):
                full((CONTROLS_DIR / name).read_bytes().decode("utf-8"), None)

    def test_missing_required_fields(self):
        for field in ("schema_version:", "board_id:", "display_name:", "status:", "support:", "capabilities:",
                      "adc:", "led:", "receiver:", "beeper:", "baro:"):
            with self.subTest(field=field):
                self.bad(self.drop_line(KAKUTE, field), "^" + field[:-1] + r": required field missing \(write")
        for field in ("  part:", "  target:", "  orientation:", "  chip:", "  cs:", "  cdc:"):
            with self.subTest(field=field):
                self.bad(self.drop_line(KAKUTE, field), r"\." + field.strip()[:-1] + ": required field missing$")
        for block in ("mcu:", "gyro:", "usb:", "uarts:", "motors:", "configurator:"):
            with self.subTest(block=block):
                self.bad(KAKUTE.replace("\n" + block, "\nrenamed_" + block, 1), "unknown top-level field 'renamed_")

    def test_required_cannot_be_absent(self):
        self.bad(KAKUTE.replace("  cs: PE4", "  cs: absent"), r"gyro\.cs: required field missing or absent")
        self.bad(KAKUTE.replace("display_name: Kakute F7 HDV", "display_name: absent"), r"display_name: required field missing or absent")
        self.bad(KAKUTE.replace("{index: 1, pin: PB0,", "{index: 1, pin: absent,"), r"motors\[0\]\.pin: required field missing or absent")

    def test_leading_zero_pins_rejected_F1(self):
        for pin in ("PA09", "PB00", "PA00", "PC015"):
            with self.subTest(pin=pin):
                self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: %s}" % pin), "invalid pin '%s'" % pin)
        self.assertIsNone(board_def.PIN_RE.fullmatch("PA09"))
        self.assertIsNone(board_def.PIN_RE.fullmatch("PA16"))
        for ok in ("PA0", "PA9", "PA10", "PK15"):
            self.assertIsNotNone(board_def.PIN_RE.fullmatch(ok))
        # PA09 used to alias PA9 (uart1 tx) and slip past the duplicate check.
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PA9}"), "duplicate pin PA9")

    def test_duplicate_pin_rejected(self):
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PE4}"), "duplicate pin PE4: gyro.cs and led.led0")
        self.bad(KAKUTE.replace("{index: 2, pin: PB1,", "{index: 2, pin: PB0,"), r"duplicate pin PB0: motors\[1\] and motors\[2\]")
        self.bad(KAKUTE.replace("{uart: 3, tx: PB10,", "{uart: 3, tx: PA9,"), "duplicate pin PA9: uart1.tx and uart3.tx")
        self.bad(KAKUTE.replace("adc: {vbat: PC3,", "adc: {vbat: PA4,"), "duplicate pin PA4")
        self.bad(MATEK.replace("scl: PB8", "scl: PB5"), "duplicate pin PB5", "matek_f722_px")
        # A receiver outside an empty uarts table still claims its pins.
        tm = (ROOT / "boards/tmotor_f7_v2.yaml").read_text()
        self.bad(tm.replace("receiver: {uart: 2, tx: PA2,", "receiver: {uart: 2, tx: PA4,"), "duplicate pin PA4: .* and receiver.tx", "tmotor_f7_v2")

    def test_duplicate_timer_rejected(self):
        self.bad(KAKUTE.replace("timer: TIM3, channel: 4", "timer: TIM3, channel: 3"), "duplicate timer use TIM3 CH3")
        self.bad(KAKUTE.replace("timer: TIM1, channel: 2", "timer: TIM1, channel: 1"), "duplicate timer use TIM1 CH1")

    def test_timer_channel_exists(self):
        for timer, ch, ok in (("TIM14", 1, True), ("TIM14", 2, False), ("TIM9", 2, True), ("TIM9", 3, False),
                              ("TIM12", 3, False), ("TIM6", 1, False), ("TIM7", 1, False), ("TIM8", 4, True)):
            raw = KAKUTE.replace("timer: TIM3, channel: 3", "timer: %s, channel: %d" % (timer, ch), 1)
            with self.subTest(timer=timer, ch=ch):
                if ok:
                    full(raw)
                else:
                    self.bad(raw, "%s has no channel %d on STM32F745" % (timer, ch))

    def test_dma(self):
        one = "{index: 1, pin: PB0, timer: TIM3, channel: 3, dma: absent}"
        self.assertIn(one, KAKUTE)
        full(KAKUTE.replace(one, one.replace("dma: absent", "dma: DMA1_S7")))
        for v in ("DMA3_S1", "DMA1_S8", "DMA1_S01", "dma1_s1", "DMA1_S1_C3"):
            with self.subTest(v=v):
                self.bad(KAKUTE.replace(one, one.replace("dma: absent", "dma: " + v)), "must look like DMA1_S2")
        two = KAKUTE.replace(one, one.replace("dma: absent", "dma: DMA2_S1"))
        two = two.replace("{index: 2, pin: PB1, timer: TIM3, channel: 4, dma: absent}",
                          "{index: 2, pin: PB1, timer: TIM3, channel: 4, dma: DMA2_S1}")
        self.bad(two, r"duplicate DMA stream DMA2_S1: motors\[1\] and motors\[2\]")

    def test_ports_per_mcu(self):
        full(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PK2}"))  # F745 has K (largest package)
        full(MATEK.replace("led0: PA14", "led0: PI2") if "led0: PA14" in MATEK else MATEK, "matek_f722_px")
        for pin in ("PJ2", "PK2"):
            with self.subTest(pin=pin):
                self.bad(MATEK.replace("led: {led0:", "led: {led0: %s, x:" % pin, 1) if False else
                         re.sub(r"led0: P[A-K]\d+", "led0: " + pin, MATEK, count=1),
                         "%s is on port %s, which STM32F722 does not have" % (pin, pin[1]), "matek_f722_px")

    def test_bus_and_clock_bounds(self):
        self.bad(KAKUTE.replace("  spi_bus: 4", "  spi_bus: 7", 1), r"gyro\.spi_bus 7 does not exist on STM32F745 \(1\.\.6\)")
        full(KAKUTE.replace("  spi_bus: 4", "  spi_bus: 6", 1))
        self.bad(MATEK.replace("  spi_bus: 1", "  spi_bus: 6", 1), r"spi_bus 6 does not exist on STM32F722 \(1\.\.5\)", "matek_f722_px")
        self.bad(MATEK.replace("i2c_bus: 1", "i2c_bus: 4", 1), r"baro\.i2c_bus 4 does not exist on STM32F722", "matek_f722_px")
        self.bad(MATEK.replace("i2c_bus: 1", "i2c_bus: 0", 1), r"baro\.i2c_bus 0 does not exist", "matek_f722_px")
        for hz, ok in ((3, False), (4, True), (26, True), (27, False)):
            raw = KAKUTE.replace("hse_mhz: 8", "hse_mhz: %d" % hz)
            with self.subTest(hz=hz):
                full(raw) if ok else self.bad(raw, "hse_mhz %d outside 4..26" % hz)
        self.bad(KAKUTE.replace("{uart: 2, tx: PD5", "{uart: 9, tx: PD5"), "uart 9 does not exist on STM32F745")
        self.bad(KAKUTE.replace("{uart: 2, tx: PD5", "{uart: 0, tx: PD5"), "uart 0 does not exist")
        self.bad(KAKUTE.replace("{uart: 2, tx: PD5", "{uart: 1, tx: PD5"), "duplicate uart in uarts")
        tm = (ROOT / "boards/tmotor_f7_v2.yaml").read_text()
        self.bad(tm.replace("receiver: {uart: 2,", "receiver: {uart: 9,"), "receiver.uart 9 does not exist on STM32F722", "tmotor_f7_v2")
        self.bad(tm.replace("receiver: {uart: 2,", "receiver: {uart: 0,"), "receiver.uart 0 does not exist", "tmotor_f7_v2")
        ml = (ROOT / "boards/mltempf4.yaml").read_text()
        self.bad(ml.replace("  spi_bus: 1", "  spi_bus: 4", 1), r"spi_bus 4 does not exist on STM32F405 \(1\.\.3\)", "mltempf4")
        self.bad(KAKUTE.replace("  spi_bus: 1\n", "  spi_bus: 4\n"), "duplicate SPI bus 4: gyro and sd")

    def test_yaml11_scalars_rejected(self):
        for v, rx in (("010", r"'010' \(leading zero\)"), ("08", r"'08' \(leading zero\)"), ("1:30", "'1:30'"), ("8.0", "'8.0'"),
                      ("1_0", "'1_0'"), ("+8", "'\\+8'")):
            with self.subTest(v=v):
                self.bad(KAKUTE.replace("hse_mhz: 8", "hse_mhz: " + v), "ambiguous scalar " + rx)
        for v in ("NO", "No", "yes", "Y", "n", "On", "OFF", "TRUE", "False", "Null", "~"):
            with self.subTest(v=v):
                self.bad(KAKUTE.replace("usb_cdc: true", "usb_cdc: " + v), "ambiguous scalar '%s'" % re.escape(v))
        self.bad(KAKUTE.replace("hse_mhz: 8", "hse_mhz: -1"), "hse_mhz: expected non-negative integer")

    def test_strings(self):
        dn = "display_name: Kakute F7 HDV"
        self.bad(KAKUTE.replace(dn, 'display_name: ""'), "display_name: empty or quoted 'absent' string")
        self.bad(KAKUTE.replace(dn, 'display_name: "absent"'), "display_name: empty or quoted 'absent' string")
        self.bad(KAKUTE.replace(dn, "display_name: 'absent'"), "empty or quoted 'absent' string")
        self.bad(KAKUTE.replace(dn, 'display_name: Kakute "F7"'), "unsupported scalar")
        self.bad(KAKUTE.replace(dn, "display_name: Kakute F7\\n"), "unsupported scalar")
        self.bad(KAKUTE.replace(dn, "display_name: \"Kakute 'F7'\""), "quotes/backslashes not allowed")
        self.bad(KAKUTE.replace(dn, 'display_name: "a\\"b"'), "quotes/backslashes not allowed")
        self.bad(KAKUTE.replace(dn, "display_name: " + "x" * 201), "display_name: string too long")
        full(KAKUTE.replace(dn, "display_name: " + "x" * 200))
        self.assertEqual(full(KAKUTE.replace(dn, 'display_name: "Kakute F7"'))["display_name"], "Kakute F7")

    def test_allowlists(self):
        for chip in ("MPU6000", "ICM42688", "BMI270"):
            full(KAKUTE.replace("  chip: MPU6000", "  chip: " + chip))
        self.bad(KAKUTE.replace("  chip: MPU6000", "  chip: MPU6500"), "gyro.chip: 'MPU6500' not one of")
        self.bad(MATEK.replace("chip: BMP280", "chip: DPS310"), "baro.chip: 'DPS310' not one of", "matek_f722_px")
        self.bad(KAKUTE.replace("protocol: CRSF", "protocol: SBUS"), "receiver.protocol: 'SBUS' not one of")

    def test_capability_consistency(self):
        tm = (ROOT / "boards/tmotor_f7_v2.yaml").read_text()
        self.bad(KAKUTE.replace("sd_logging: true", "sd_logging: true").replace(
            KAKUTE[KAKUTE.index("\nsd:"):KAKUTE.index("\n", KAKUTE.index("detect:"))], "\nsd: absent"),
            "sd_logging requires an sd block")
        self.bad(KAKUTE.replace("  cdc: true", "  cdc: false"), "usb.cdc must equal capabilities.usb_cdc")
        self.bad(KAKUTE.replace("usb_cdc: true", "usb_cdc: false"), "usb.cdc must equal capabilities.usb_cdc")
        dummy = (ROOT / "boards/dummy.yaml").read_text()
        full(dummy, "dummy")  # host-only: no hardware caps, CDC console in the host build
        self.bad(re.sub(r"motors:.*", "motors: []", KAKUTE, count=1, flags=re.S) if False else
                 KAKUTE[:KAKUTE.index("\nmotors:")] + "\nmotors: []" + KAKUTE[KAKUTE.index("\nled:"):],
                 "motor_output requires motors")

    def test_receiver_uart_in_table(self):
        self.bad(KAKUTE.replace("receiver: {uart: 6, tx: PC6, rx: PC7", "receiver: {uart: 5, tx: PC12, rx: PD2"),
                 "receiver.uart 5 is not in the uarts table")
        self.bad(KAKUTE.replace("receiver: {uart: 6, tx: PC6, rx: PC7", "receiver: {uart: 6, tx: PC6, rx: PA10"),
                 "receiver pins must equal its uarts row")

    def test_tree_checks(self):
        ls = "linker_script: cmake/stm32f745.ld"
        for v, rx in (("cmake/nope.ld", "does not exist"), ("cmake/../cmake/stm32f745.ld", "inside the tree"),
                      ("/etc/passwd", "inside the tree"), ("cmake/stm32f745.txt", "inside the tree"),
                      ("cmake", "inside the tree")):
            with self.subTest(v=v):
                self.bad(KAKUTE.replace(ls, "linker_script: " + v), "linker_script '%s' .*" % re.escape(v) + rx)
        self.bad(KAKUTE.replace("  target: stm32f745", "  target: stm32f746").replace("part: STM32F745", "part: STM32F746"),
                 "mcu.target 'stm32f746' is not a known MCU target")
        self.bad(KAKUTE.replace("part: STM32F745", "part: STM32F722"), "mcu.part must match mcu.target")
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / "cmake").mkdir()
            shutil.copy(ROOT / "cmake/stm32f745.ld", Path(t) / "cmake")
            with self.assertRaisesRegex(BoardDefError, "mcu.target 'stm32f745' has no targets/mcus definition"):
                full(KAKUTE, root=Path(t))
            (Path(t) / "targets/mcus").mkdir(parents=True)
            shutil.copy(ROOT / "targets/mcus/stm32f745.json", Path(t) / "targets/mcus")
            full(KAKUTE, root=Path(t))
        h = KAKUTE.replace("  target: stm32f745", "  target: stm32h743").replace("part: STM32F745", "part: STM32H743")
        self.bad(h, "no verified resource table for STM32H743")

    def test_boards_dir_only_yaml(self):
        with tempfile.TemporaryDirectory() as t:
            b = Path(t) / "boards"
            b.mkdir()
            (b / "kakute_f7_hdv.yaml").write_text(KAKUTE)
            (b / "README.md").write_text("x")
            self.assertEqual([p.name for p in board_def.board_files(Path(t))], ["kakute_f7_hdv.yaml"])
            for name in ("x.yml", "x.YAML", "x.txt", "Bad.yaml", ".x.yaml"):
                with self.subTest(name=name):
                    (b / name).write_text(KAKUTE)
                    with self.assertRaisesRegex(BoardDefError, re.escape("boards/%s: only <board_id>.yaml" % name)):
                        board_def.board_files(Path(t))
                    (b / name).unlink()
            (b / "sub").mkdir()
            (b / "sub" / "x.yaml").write_text(KAKUTE)
            with self.assertRaisesRegex(BoardDefError, "boards/sub: only <board_id>.yaml"):
                board_def.board_files(Path(t))

    def test_parser_structure(self):
        self.bad(KAKUTE.replace("status: bf-derived", "status: bf-derived\nstatus: bf-derived"), "duplicate key: status")
        self.bad(KAKUTE.replace("{index: 1, pin: PB0, timer: TIM3, channel: 3, dma: absent}",
                                "{index: 1, pin: PB0, timer: TIM3, channel: 3, dma: absent, dma: absent}"), "duplicate key: dma")
        self.bad(KAKUTE.replace("\nmcu:\n", "\n\tmcu:\n"), "tabs are not allowed")
        self.bad("", "empty board definition")
        self.bad("# only\n", "empty board definition")
        self.bad("  board_id: x\n", "empty board definition")
        self.bad(KAKUTE + "  stray: 1\n", "bad indentation")
        self.bad(KAKUTE.replace("hse_mhz: 8", "hse_mhz: *x"), "unsupported scalar")
        self.bad(KAKUTE.replace("hse_mhz: 8", "hse_mhz:"), "needs a nested block")

    def test_parser_errors(self):
        self.bad(KAKUTE.replace("adc: {vbat: PC3,", "adc: {vbat: ,"), r"empty value \(write `absent`\)")
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PA2}}"), "unbalanced flow collection")
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PA2"), "unterminated flow mapping")
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0 PA2}"), "bad flow item 'led0 PA2'")
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {Led0: PA2}"), "bad flow item")
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: [PA2"), "unterminated flow list")
        self.bad(KAKUTE.replace("  - {uart: 1, tx: PA9, rx: PA10}", "  - uart: 1"), r"use `- \{\.\.\.\}` list items")
        no_rows = re.sub(r"\n  - \{uart: [^\n]*", "", KAKUTE).replace("\nuarts:", "\nuarts: {uart: 6}", 1)
        self.bad(no_rows, r"^uarts: expected list \(use \[\] for none\)")
        with self.assertRaisesRegex(BoardDefError, "board definition must be a mapping"):
            validate(parse_yaml("- {a: 1}\n"))

    def test_load_runs_tree_checks(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / "boards").mkdir()
            (Path(t) / "boards/kakute_f7_hdv.yaml").write_text(KAKUTE)
            with self.assertRaisesRegex(BoardDefError, "has no targets/mcus definition"):
                board_def.load(Path(t) / "boards/kakute_f7_hdv.yaml")
            with self.assertRaisesRegex(BoardDefError, "has no targets/mcus definition"):
                board_def.load(Path(t) / "boards/kakute_f7_hdv.yaml", Path(t))
        self.assertEqual(board_def.load(ROOT / "boards/kakute_f7_hdv.yaml")["board_id"], "kakute_f7_hdv")

    def test_bad_values(self):
        for old, new, rx in (("cs: PE4", "cs: PE16", "invalid pin 'PE16'"), ("cs: PE4", "cs: E4", "invalid pin 'E4'"),
                             ("cs: PE4", "cs: PL4", "invalid pin 'PL4'"),
                             ("orientation: CW270_DEG", "orientation: CW45", "'CW45' not one of"),
                             ("status: bf-derived", "status: tested", "'tested' not one of"),
                             ("support: development", "support: flying", "'flying' not one of"),
                             ("timer: TIM1, channel: 1", "timer: TIM1, channel: 5", "TIM1 has no channel 5"),
                             ("timer: TIM1, channel: 1", "timer: T1, channel: 1", r"\.timer invalid"),
                             ("schema_version: 1", "schema_version: 2", "unsupported schema_version"),
                             ("usb_cdc: true", "usb_cdc: 1", r"capabilities\.usb_cdc: expected bool"),
                             ("display_name: Kakute F7 HDV", "display_name: 7", "display_name: expected str"),
                             ("{index: 3,", "{index: 5,", "indexed 1..N"),
                             ("hse_mhz: 8", "hse_mhz: -8", "expected non-negative integer"),
                             ("hse_mhz: 8", "hse_mhz: eight", "expected non-negative integer")):
            with self.subTest(new=new):
                self.bad(KAKUTE.replace(old, new, 1), rx)

    def test_identity_and_unknown_fields(self):
        self.bad(KAKUTE, "board_id 'kakute_f7_hdv' must match file name 'other_name'", "other_name")
        self.bad(KAKUTE + "pinout_extra: 1\n", "unknown top-level field 'pinout_extra'")
        self.bad(KAKUTE.replace("  cs: PE4", "  cs: PE4\n  cs2: PE3"), "gyro: unknown field 'cs2'")
        for bid in ("Kakute", "kakute f7", "1kakute", "kakute.f7"):
            with self.subTest(bid=bid):
                self.bad(KAKUTE.replace("board_id: kakute_f7_hdv", "board_id: " + bid), "board_id: invalid identifier", None)
        long_id = "k" * 48
        self.bad(KAKUTE.replace("board_id: kakute_f7_hdv", "board_id: " + long_id), "board_id too long", long_id)
        full(KAKUTE.replace("board_id: kakute_f7_hdv", "board_id: " + "k" * 47), "k" * 47)

    def test_support_policy(self):
        self.bad(KAKUTE.replace("status: bf-derived", "status: stub"), "hardware target requires a bf-derived/verified")
        tm = (ROOT / "boards/tmotor_f7_v2.yaml").read_text()
        self.bad(tm.replace("motor_output: false", "motor_output: true"), "sensor-only target cannot advertise motor output", "tmotor_f7_v2")
        ml = (ROOT / "boards/mltempf4.yaml").read_text()
        self.bad(ml.replace("  artifact_name: bobflight-mltempf4-usb-diagnostic.hex\n", ""), "diagnostic profile requires configurator.artifact_name", "mltempf4")
        self.bad(ml.replace("image_profile: f405-usb-diagnostic", "image_profile: main"), "image_profile must match support", "mltempf4")
        self.bad(ml.replace("artifact_name: bobflight-mltempf4-usb-diagnostic.hex", "artifact_name: mltempf4.hex"), "invalid artifact_name", "mltempf4")
        self.bad(ml.replace("artifact_name: bobflight-mltempf4-usb-diagnostic.hex", "artifact_name: bobflight-Ml.hex"), "invalid artifact_name", "mltempf4")
        self.bad(ml.replace("usb_cdc: true, sd_logging: false", "usb_cdc: true, sd_logging: true"), "diagnostic profiles have no motor/SD capability", "mltempf4")
        dummy = (ROOT / "boards/dummy.yaml").read_text()
        self.bad(dummy.replace("motor_output: false", "motor_output: true"), "host-only board cannot advertise hardware capabilities", "dummy")
        self.bad(dummy.replace("usb_cdc: false", "usb_cdc: true"), "host-only board cannot advertise hardware capabilities", "dummy")
        st = re.search(r"^status: (\S+)", dummy, re.M).group(1)
        self.bad(dummy.replace("status: " + st, "status: verified"), "host-only board must be stub/draft", "dummy")
        dev = KAKUTE[:KAKUTE.index("\ngyro:")] + "\ngyro: absent" + KAKUTE[KAKUTE.index("\nbaro:"):]
        self.bad(dev, "physical board requires a gyro block")
        self.bad(KAKUTE.replace("  image_profile: main", "  image_profile: main\n  artifact_name: bobflight-x.hex"),
                 "main builds name their artifact from board_id")
        for k, v in (("support_label", "X"), ("mcu_display", "X")):
            self.bad(KAKUTE.replace("  image_profile: main", "  image_profile: main\n  %s: %s" % (k, v)),
                     "only diagnostic profiles carry custom/support_label/mcu_display")
        self.bad(KAKUTE.replace("  image_profile: main", "  image_profile: main\n  menu_order: 3"), "menu_order applies to diagnostic profiles only")

    def test_routing_guards(self):
        for old, new in (("cs: PB12", "cs: PB11"), ("mosi: PC3", "mosi: PD3")):
            with self.subTest(new=new):
                self.bad(MATEK.replace(old, new, 1), "unsupported flash SPI routing", "matek_f722_px")
        self.bad(MATEK.replace("scl: PB8, sda: PB9", "scl: PB6, sda: PB7") if "scl: PB8, sda: PB9" in MATEK else
                 MATEK.replace("scl: PB8", "scl: PB6"), "unsupported barometer I2C routing", "matek_f722_px")
        self.bad(MATEK.replace("i2c_bus: 1", "i2c_bus: 2"), "unsupported barometer I2C routing", "matek_f722_px")

    def test_missing_capability_rejected_K4e(self):
        for cap in ("motor_output", "usb_cdc", "sd_logging"):
            with self.subTest(cap=cap):
                raw = re.sub(r"(capabilities: \{.*?)\b%s: \w+,? ?" % cap, r"\1", KAKUTE, count=1).replace(", }", "}")
                self.assertNotIn(cap + ":", raw.split("capabilities:")[1].split("\n")[0])
                self.bad(raw, r"^capabilities\.%s: required field missing$" % cap)

    def test_diagnostic_motor_output_rejected_K4g(self):
        for name in ("mltempf4", "custom_f405xg_usb"):
            raw = (ROOT / f"boards/{name}.yaml").read_text()
            with self.subTest(name=name):
                self.bad(raw.replace("motor_output: false", "motor_output: true"),
                         "diagnostic profiles have no motor/SD capability", name)
                self.bad(raw.replace("sd_logging: false", "sd_logging: true"),
                         "diagnostic profiles have no motor/SD capability", name)

    def test_duplicate_display_name_rejected(self):
        defs = [board_def.load(p) for p in board_def.board_files(ROOT)]
        board_def.check_set(defs)
        tm = dict(defs[[d["board_id"] for d in defs].index("tmotor_f7_v2")])
        kak = next(d for d in defs if d["board_id"] == "kakute_f7_hdv")
        tm["display_name"] = kak["display_name"]
        with self.assertRaisesRegex(BoardDefError, "duplicate display_name 'Kakute F7 HDV': kakute_f7_hdv and tmotor_f7_v2"):
            board_def.check_set([kak, tm])
        with tempfile.TemporaryDirectory() as t:
            for sub in ("boards", "targets/mcus", "cmake"):
                (Path(t) / sub).mkdir(parents=True)
            shutil.copy(ROOT / "targets/mcus/stm32f745.json", Path(t) / "targets/mcus")
            shutil.copy(ROOT / "cmake/stm32f745.ld", Path(t) / "cmake")
            (Path(t) / "boards/kakute_f7_hdv.yaml").write_text(KAKUTE)
            (Path(t) / "boards/kakute_copy.yaml").write_text(KAKUTE.replace("board_id: kakute_f7_hdv", "board_id: kakute_copy"))
            r = subprocess.run([sys.executable, str(ROOT / "scripts/board_def.py"), "--root", t], capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)
            self.assertIn("duplicate display_name 'Kakute F7 HDV'", r.stderr)
            (Path(t) / "boards/x.yml").write_text(KAKUTE)
            r = subprocess.run([sys.executable, str(ROOT / "scripts/board_def.py"), "--root", t], capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)
            self.assertIn("boards/x.yml: only <board_id>.yaml", r.stderr)

    def test_absent_never_becomes_a_pin(self):
        d = board_def.to_ir(board_def.load(ROOT / "boards/custom_f405xg_usb.yaml"))
        for k in ("cs", "exti", "tx", "rx", "led0", "vbat", "current", "sck", "miso", "mosi"):
            self.assertEqual(d[k], "")
        self.assertEqual(d["motors"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
