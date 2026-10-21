#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Actual host firmware `version`: the main 5bea523 reply and `status` board: line are
unchanged byte for byte; board_id / board_target / board_mcu are appended, with values
equal to boards/<board_id>.yaml (id, mcu.target, lower-case mcu.part) and only [a-z0-9_-]."""
import json, re, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import board_def  # noqa: E402

exe, board = sys.argv[1], sys.argv[2]
golden = json.loads((ROOT / "tests/golden/board_id/main_5bea523_version_status.json").read_text())["boards"][board]
d = board_def.load(ROOT / "boards" / f"{board}.yaml")
ident = [("board_id", d["board_id"]), ("board_target", d["mcu"]["target"]), ("board_mcu", d["mcu"]["part"].lower())]
for _, v in ident:
    assert re.fullmatch(r"[a-z0-9_-]+", v), v

def run(cmds):
    return subprocess.run([exe], input=cmds, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True).stdout.decode("latin1")

empty, ver, stat = run(b""), run(b"version\n"), run(b"status\n")
i = 0
while i < min(len(empty), len(ver)) and empty[i] == ver[i]:
    i += 1
j = 0
while j < len(empty) - i and ver[-1 - j] == empty[-1 - j]:
    j += 1
reply = ver[i:len(ver) - j]
old = golden["version_reply"]
assert reply.startswith(old), ("existing version bytes changed", reply, old)
tail = reply[len(old):]
sep = "" if old.endswith("\r\n") else "\r\n"   # pre-existing truncation keeps its exact bytes
expected = sep + "".join(f"{k}: {v}\r\n" for k, v in ident)
assert tail == expected, (tail, expected)
assert stat.count(golden["status_board_line"]) == 1, "status board: line changed"
assert "board_id:" not in stat and "board_target:" not in stat and "board_mcu:" not in stat, "status must not gain keys"
print(f"PASS {board}: version prefix byte-identical to main ({len(old)} bytes), +{len(expected)} additive bytes, status board: unchanged")
