#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Board definition schema validator: every checked-in board passes; malformed,
incomplete and conflicting definitions are rejected."""
import sys
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


class Schema(unittest.TestCase):
    def test_all_checked_in_boards_valid(self):
        files = board_def.board_files(ROOT)
        self.assertGreaterEqual(len(files), 6)
        for p in files:
            with self.subTest(p.name):
                d = board_def.load(p)
                self.assertEqual(d["board_id"], p.stem)
                self.assertTrue(p.read_text().startswith("# SPDX-License-Identifier: Apache-2.0"))

    def bad(self, raw, stem="kakute_f7_hdv"):
        with self.assertRaises(BoardDefError):
            check(raw, stem)

    def drop_line(self, raw, prefix):
        lines = raw.splitlines(keepends=True)
        i = next(i for i, l in enumerate(lines) if l.startswith(prefix))
        return "".join(lines[:i] + lines[i + 1:])

    def test_missing_required_fields(self):
        for field in ("schema_version:", "board_id:", "display_name:", "status:", "support:", "capabilities:",
                      "adc:", "led:", "receiver:", "beeper:", "baro:", "  part:", "  target:", "  orientation:",
                      "  chip:", "  cs:", "  cdc:"):
            with self.subTest(field=field):
                self.bad(self.drop_line(KAKUTE, field))
        for block in ("mcu:", "gyro:", "usb:", "uarts:", "motors:", "configurator:"):
            with self.subTest(block=block):
                self.bad(KAKUTE.replace("\n" + block, "\nrenamed_" + block, 1))

    def test_required_cannot_be_absent(self):
        self.bad(KAKUTE.replace("  cs: PE4", "  cs: absent"))
        self.bad(KAKUTE.replace("display_name: Kakute F7 HDV", "display_name: absent"))
        self.bad(KAKUTE.replace("{index: 1, pin: PB0,", "{index: 1, pin: absent,"))

    def test_duplicate_pin_rejected(self):
        self.bad(KAKUTE.replace("led: {led0: PA2}", "led: {led0: PE4}"))         # gyro CS
        self.bad(KAKUTE.replace("{index: 2, pin: PB1,", "{index: 2, pin: PB0,"))  # motor 1
        self.bad(KAKUTE.replace("{uart: 3, tx: PB10,", "{uart: 3, tx: PA9,"))     # uart1 tx
        self.bad(KAKUTE.replace("adc: {vbat: PC3,", "adc: {vbat: PA4,"))         # SD CS
        self.bad(MATEK.replace("scl: PB8", "scl: PB5"), "matek_f722_px")         # motor 4

    def test_duplicate_timer_rejected(self):
        self.bad(KAKUTE.replace("timer: TIM3, channel: 4", "timer: TIM3, channel: 3"))
        self.bad(KAKUTE.replace("timer: TIM1, channel: 2", "timer: TIM1, channel: 1"))

    def test_duplicate_keys_uarts_buses(self):
        self.bad(KAKUTE.replace("status: bf-derived", "status: bf-derived\nstatus: bf-derived"))
        self.bad(KAKUTE.replace("{uart: 2, tx: PD5", "{uart: 1, tx: PD5"))
        self.bad(KAKUTE.replace("  spi_bus: 1\n", "  spi_bus: 4\n"))  # SD on the gyro bus
        self.bad(KAKUTE.replace("{index: 1, pin: PB0, timer: TIM3, channel: 3, dma: absent}",
                                "{index: 1, pin: PB0, timer: TIM3, channel: 3, dma: absent, dma: absent}"))

    def test_bad_values(self):
        for old, new in (("cs: PE4", "cs: PE16"), ("cs: PE4", "cs: E4"), ("orientation: CW270_DEG", "orientation: CW45"),
                         ("status: bf-derived", "status: tested"), ("support: development", "support: flying"),
                         ("timer: TIM1, channel: 1", "timer: TIM1, channel: 5"), ("timer: TIM1, channel: 1", "timer: T1, channel: 1"),
                         ("receiver: {uart: 6, tx: PC6, rx: PC7", "receiver: {uart: 6, tx: PC6, rx: PA10"),
                         ("schema_version: 1", "schema_version: 2"), ("usb_cdc: true", "usb_cdc: yes"),
                         ("{index: 3,", "{index: 5,"), ("hse_mhz: 8", "hse_mhz: -8"), ("hse_mhz: 8", "hse_mhz:")):
            with self.subTest(new=new):
                self.bad(KAKUTE.replace(old, new, 1))

    def test_identity_and_unknown_fields(self):
        self.bad(KAKUTE, "other_name")
        self.bad(KAKUTE + "pinout_extra: 1\n")
        self.bad(KAKUTE.replace("  cs: PE4", "  cs: PE4\n  cs2: PE3"))
        self.bad(KAKUTE.replace("\nmcu:\n", "\n\tmcu:\n"))

    def test_support_policy(self):
        self.bad(KAKUTE.replace("status: bf-derived", "status: stub"))
        tm = (ROOT / "boards/tmotor_f7_v2.yaml").read_text()
        self.bad(tm.replace("motor_output: false", "motor_output: true"), "tmotor_f7_v2")
        ml = (ROOT / "boards/mltempf4.yaml").read_text()
        self.bad(ml.replace("  artifact_name: bobflight-mltempf4-usb-diagnostic.hex\n", ""), "mltempf4")
        self.bad(ml.replace("image_profile: f405-usb-diagnostic", "image_profile: main"), "mltempf4")

    def test_absent_never_becomes_a_pin(self):
        d = board_def.to_ir(board_def.load(ROOT / "boards/custom_f405xg_usb.yaml"))
        for k in ("cs", "exti", "tx", "rx", "led0", "vbat", "current", "sck", "miso", "mosi"):
            self.assertEqual(d[k], "")
        self.assertEqual(d["motors"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
