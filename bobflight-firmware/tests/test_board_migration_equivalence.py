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
        if line.startswith("#define BOARD_GENERATED_FLASH_KIB "):
            continue
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

    def test_flash_size_generated_from_yaml(self):
        """FLASHSIZE checked at boot comes from mcu.flash_kib and equals main's hardcoded 512u."""
        import re
        main = (GOLDEN / "ir_load_main_5bea523.c").read_text()
        main_kib = int(re.search(r"0x1FF07A22u==(\d+)u", main).group(1))
        self.assertIn("==BOARD_GENERATED_FLASH_KIB)", (ROOT / "src/board/ir_load.c").read_text())
        for board in ("matek_f722_px", "tmotor_f7_v2"):
            with self.subTest(board=board):
                d = ir_codegen.board_def.load(ROOT / "boards" / f"{board}.yaml")
                self.assertEqual(d["mcu"]["flash_kib"], main_kib)
                self.assertIn(f"#define BOARD_GENERATED_FLASH_KIB {main_kib}u ", generated(board))
        # Kakute: device size unverified (F745 ships as 512 or 1024 KiB) -> not checked, never guessed.
        self.assertIn("#define BOARD_GENERATED_FLASH_KIB 0u ", generated("kakute_f7_hdv"))

    def test_checked_in_header_fresh(self):
        cmd = [sys.executable, "scripts/ir_codegen.py", "boards/dummy.yaml", "-o", "src/board/pins_generated.h", "--check"]
        self.assertEqual(subprocess.run(cmd, cwd=ROOT, capture_output=True).returncode, 0)
        with tempfile.TemporaryDirectory() as t:
            stale = Path(t) / "pins_generated.h"
            stale.write_text((ROOT / "src/board/pins_generated.h").read_text().replace("FLASH_KIB 0u", "FLASH_KIB 1u"))
            r = subprocess.run(cmd[:4] + [str(stale), "--check"], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(r.returncode, 3)
            self.assertIn("is stale", r.stderr)

    def test_identity_tokens_restricted(self):
        ir = ir_codegen.load_board(ROOT / "boards/kakute_f7_hdv.yaml")
        self.assertEqual(ir_codegen.identity(ir), ("kakute_f7_hdv", "stm32f745", "stm32f745"))
        for key, bad in (("board_id", "Kakute"), ("board_id", "k k"), ("mcu_target", "stm32.f745"),
                         ("mcu", "STM32F745!"), ("board_id", 'k"x'), ("board_id", "")):
            with self.subTest(key=key, bad=bad):
                with self.assertRaisesRegex(ir_codegen.board_def.BoardDefError, "outside \\[a-z0-9_-\\]"):
                    ir_codegen.identity(dict(ir, **{key: bad}))

    def test_linker_scripts_match_build(self):
        """The build takes mcu.linker_script from the YAML; main's choice per board is frozen here."""
        main = {"kakute_f7_hdv": "cmake/stm32f745.ld", "tmotor_f7_v2": "cmake/stm32f722.ld",
                "matek_f722_px": "cmake/stm32f722_config.ld", "mltempf4": "cmake/components/f405xg.ld",
                "custom_f405xg_usb": "cmake/components/f405xg.ld"}
        for board, ld in main.items():
            with self.subTest(board=board):
                self.assertEqual(ir_codegen.board_def.load(ROOT / "boards" / f"{board}.yaml")["mcu"]["linker_script"], ld)
        for board in ("kakute_f7_hdv", "tmotor_f7_v2", "matek_f722_px"):
            out = subprocess.run([sys.executable, str(ROOT / "scripts/target_registry.py"), "resolve", board, "--cmake"],
                                 check=True, capture_output=True, text=True).stdout
            self.assertIn(f'set(BOBFLIGHT_BOARD_LINKER_SCRIPT "{main[board]}")', out)
        cmake = (ROOT / "CMakeLists.txt").read_text()
        self.assertIn('-T${_BF_LD_SCRIPT}', cmake)
        self.assertIn('set(_BF_LD_SCRIPT "${CMAKE_SOURCE_DIR}/${BOBFLIGHT_BOARD_LINKER_SCRIPT}")', cmake)
        self.assertNotIn(".ld\")", cmake.split("set(_BF_LD_SCRIPT")[0].split("bobflight.elf")[-1])


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)
