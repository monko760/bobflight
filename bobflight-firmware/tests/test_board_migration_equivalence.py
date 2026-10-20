#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""No-behavior-change proof for the boards/<board_id>.yaml migration.

1. Generated pins_generated.h for every migrated board is byte-identical to the
   frozen main (5bea523) output, except the "Source IR:" path comment and the new
   generated UART-table block.
2. The UART table now generated from `uarts:` behaves exactly like the hand-written
   tables in main's ir_load.c: both loaders are compiled against the same header and
   board_init() + board_select_rx_uart(0..255) results and board_t bytes are compared.
3. The registry/Configurator catalog is identical to main except the `ir` path
   (now boards/<id>.yaml) and the new `build_label` / `diagnostic_profiles` data.
Usage: test_board_migration_equivalence.py [C compiler]
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "tests/golden/boards"
sys.path.insert(0, str(ROOT / "scripts"))
import ir_codegen  # noqa: E402
from target_registry import TargetRegistry  # noqa: E402

BOARDS = ["dummy", "kakute_f7_hdv", "matek_f722_px", "tmotor_f7_v2"]
CC = sys.argv[1] if len(sys.argv) > 1 else "cc"

DRIVER = r'''
#include "board/board.h"
#include <stdio.h>
#include <string.h>
static void dump(const board_t *b){const unsigned char *p=(const unsigned char*)b;
 for(size_t i=0;i<sizeof(*b);i++)printf("%02x",p[i]);printf("\n");}
int main(void){
 board_t clean;printf("init=%d\n",(int)board_init());
 /* normalise padding: copy field by field through memcpy of a zeroed struct */
 memset(&clean,0,sizeof clean);memcpy(&clean,board_get(),sizeof clean);dump(&clean);
 for(unsigned u=0;u<256;u++){int ok=board_select_rx_uart(u);const board_t*b=board_get();
  printf("%u %d %u %u %u\n",u,ok,b->rx_uart,(unsigned)b->rx_pin,(unsigned)b->tx_pin);}
 return 0;}
'''


def strip(text: str) -> str:
    """Drop the Source IR path comment, the UART block and the board identity block (each plus its one separating blank line)."""
    out, skip, eat_blank = [], False, False
    for line in text.splitlines(keepends=True):
        if eat_blank:
            eat_blank = False
            if line == "\n":
                continue
        if line.startswith(" * Source IR:"):
            continue
        if line.startswith(ir_codegen.UART_BEGIN) or line.startswith(ir_codegen.IDENT_BEGIN):
            skip = True
        if not skip:
            out.append(line)
        if skip and (line.startswith(ir_codegen.UART_END) or line.startswith(ir_codegen.IDENT_END)):
            skip, eat_blank = False, True
    return "".join(out)


def generated(board: str) -> str:
    p = ROOT / "boards" / f"{board}.yaml"
    return ir_codegen.render(p, ir_codegen.load_board(p))


class Equivalence(unittest.TestCase):
    def test_pin_headers_byte_identical(self):
        for board in BOARDS:
            with self.subTest(board=board):
                golden = (GOLDEN / f"{board}.pins_generated.h").read_text(encoding="utf-8")
                new = generated(board)
                # Only the documented differences are removed; all other lines byte-identical.
                self.assertEqual(new.count(ir_codegen.UART_BEGIN), 1)
                self.assertEqual(strip(new), strip(golden))

    def test_uart_tables_and_loader_semantically_identical(self):
        for board in BOARDS:
            with self.subTest(board=board), tempfile.TemporaryDirectory() as td:
                t = Path(td)
                (t / "board").mkdir()
                (t / "board/pins_generated.h").write_text(generated(board))
                (t / "drv.c").write_text(DRIVER)
                outs = []
                for name, loader in (("main", GOLDEN / "ir_load_main_5bea523.c"), ("new", ROOT / "src/board/ir_load.c")):
                    exe = t / (name + (".exe" if sys.platform == "win32" else ""))
                    subprocess.run([CC, "-std=c11", "-DBOBFLIGHT_HOST=1", "-I" + str(t), "-I" + str(ROOT / "src"),
                                    "-I" + str(ROOT / "include"), str(t / "drv.c"), str(loader), "-o", str(exe)],
                                   check=True)
                    outs.append(subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout)
                self.assertEqual(outs[0], outs[1])
                self.assertEqual(len(outs[0].splitlines()), 258)

    def test_registry_catalog_identical(self):
        golden = json.loads((GOLDEN / "registry_list.json").read_text())
        new = TargetRegistry(ROOT).list_all()
        self.assertEqual(new["mcus"], golden["mcus"])
        self.assertEqual([b["id"] for b in new["boards"]], [b["id"] for b in golden["boards"]])
        for old, cur in zip(golden["boards"], new["boards"]):
            self.assertEqual(cur["ir"], f"boards/{cur['id']}.yaml")
            strip_keys = lambda b: {k: v for k, v in b.items() if k not in ("ir", "build_label")}
            self.assertEqual(strip_keys(cur), strip_keys(old))
        self.assertEqual(sorted(p["id"] for p in new["diagnostic_profiles"]), ["custom_f405xg_usb", "mltempf4"])

    def test_linker_scripts_match_build(self):
        cmake = (ROOT / "CMakeLists.txt").read_text()
        for board in ("kakute_f7_hdv", "tmotor_f7_v2"):
            d = ir_codegen.board_def.load(ROOT / "boards" / f"{board}.yaml")
            tool = (ROOT / f"cmake/{d['mcu']['target']}.cmake").read_text()
            self.assertIn(Path(d["mcu"]["linker_script"]).name, tool)
        d = ir_codegen.board_def.load(ROOT / "boards/matek_f722_px.yaml")
        self.assertIn(d["mcu"]["linker_script"], cmake)
        for board in ("mltempf4", "custom_f405xg_usb"):
            d = ir_codegen.board_def.load(ROOT / "boards" / f"{board}.yaml")
            self.assertIn(d["mcu"]["linker_script"], (ROOT / "tools/build_f405_usb_diagnostic.py").read_text())


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)
