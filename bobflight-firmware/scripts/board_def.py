#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""BobFlight board definitions: boards/<board_id>.yaml (schema_version 1).

One file per board is the single source of truth for pin codegen
(scripts/ir_codegen.py), the target registry (scripts/target_registry.py)
and the Configurator catalog / local HEX builder.

Standard library only. The YAML accepted is a strict subset (block mappings,
block lists, one-line flow mappings/lists, plain or quoted scalars, comments).
Anything outside that subset, duplicate keys and unknown fields are errors.
`absent` means "not present on this board or not verified"; never guess a pin.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA_VERSION = 1
ABSENT = None
PIN_RE = re.compile(r"P([A-K])(\d{1,2})")
ID_RE = re.compile(r"[a-z][a-z0-9_]*")
STATUSES = ("stub", "draft", "bf-derived", "verified", "golden", "ready")
PACKABLE = {"bf-derived", "verified", "golden", "ready"}
SUPPORTS = ("host-only", "sensor-only", "development", "diagnostic")
ORIENTATIONS = ("CW0_DEG", "CW90_DEG", "CW180_DEG", "CW270_DEG", "CW180_DEG_FLIP")
IMAGE_PROFILES = ("main", "f405-usb-diagnostic")


class BoardDefError(ValueError):
    pass


def _req(ok, msg):
    if not ok:
        raise BoardDefError(msg)


# --------------------------------------------------------------------------- YAML subset
def _scalar(tok: str):
    t = tok.strip()
    _req(t != "", "empty value (write `absent`)")
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
        return t[1:-1]
    if t in ("true", "false"):
        return t == "true"
    if t == "absent":
        return ABSENT
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    _req(t not in ("null", "~", "yes", "no", "on", "off"), f"ambiguous scalar {t!r}")
    _req(not any(c in t for c in "{}[],&*!|>%@`"), f"unsupported scalar {t!r}")
    return t


def _split_flow(body: str) -> list[str]:
    parts, depth, cur, quote = [], 0, "", ""
    for c in body:
        if quote:
            cur += c
            if c == quote:
                quote = ""
            continue
        if c in "\"'":
            quote = c
        elif c in "{[":
            depth += 1
        elif c in "}]":
            depth -= 1
        if c == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += c
    _req(depth == 0 and not quote, "unbalanced flow collection")
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts]


def _value(tok: str):
    t = tok.strip()
    if t.startswith("{"):
        _req(t.endswith("}"), "unterminated flow mapping")
        out = {}
        for item in _split_flow(t[1:-1]):
            k, sep, v = item.partition(":")
            _req(sep == ":" and re.fullmatch(r"[a-z][a-z0-9_]*", k.strip()), f"bad flow item {item!r}")
            _req(k.strip() not in out, f"duplicate key: {k.strip()}")
            out[k.strip()] = _value(v)
        return out
    if t.startswith("["):
        _req(t.endswith("]"), "unterminated flow list")
        return [_value(i) for i in _split_flow(t[1:-1])]
    return _scalar(t)


def _strip_comment(line: str) -> str:
    quote = ""
    for i, c in enumerate(line):
        if quote:
            if c == quote:
                quote = ""
        elif c in "\"'":
            quote = c
        elif c == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def parse_yaml(text: str):
    lines = []
    for n, raw in enumerate(text.splitlines(), 1):
        _req("\t" not in raw, f"line {n}: tabs are not allowed")
        s = _strip_comment(raw).rstrip()
        if s.strip():
            lines.append((n, len(s) - len(s.lstrip(" ")), s.strip()))
    pos = 0

    def block(indent):
        nonlocal pos
        _req(pos < len(lines), "unexpected end of file")
        if lines[pos][2].startswith("- ") or lines[pos][2] == "-":
            out = []
            while pos < len(lines) and lines[pos][1] == indent and lines[pos][2].startswith("- "):
                n, _, s = lines[pos]
                _req(not re.match(r"- [a-z_]+:\s", s) or s[2] in "{[", f"line {n}: use `- {{...}}` list items")
                out.append(_value(s[2:]))
                pos += 1
            return out
        out = {}
        while pos < len(lines) and lines[pos][1] == indent:
            n, _, s = lines[pos]
            m = re.fullmatch(r"([a-z][a-z0-9_]*):(?:\s+(.*))?", s)
            _req(m is not None, f"line {n}: expected `key: value`")
            key = m.group(1)
            _req(key not in out, f"line {n}: duplicate key: {key}")
            pos += 1
            if m.group(2) is None:
                _req(pos < len(lines) and lines[pos][1] > indent, f"line {n}: `{key}:` needs a nested block (or `absent`)")
                out[key] = block(lines[pos][1])
            else:
                out[key] = _value(m.group(2))
        return out

    _req(lines and lines[0][1] == 0, "empty board definition")
    doc = block(0)
    _req(pos == len(lines), f"line {lines[pos][0] if pos < len(lines) else '?'}: bad indentation")
    return doc


# --------------------------------------------------------------------------- schema
# field: (type, required). Types: str, int, bool, pin, id, enum tuple, dict-schema, ("list", schema)
OPT = False
REQ = True
CUSTOM_SCHEMA = {"mcu": (str, REQ), "flash_kib": (int, REQ), "hse_hz": (int, REQ)}
CONFIGURATOR_SCHEMA = {
    "image_profile": (IMAGE_PROFILES, REQ),
    "build_label": (str, OPT),
    "artifact_name": (str, OPT),
    "mcu_display": (str, OPT),
    "support_label": (str, OPT),
    "menu_order": (int, OPT),
    "custom": (CUSTOM_SCHEMA, OPT),
}
SCHEMA = {
    "schema_version": (int, REQ),
    "board_id": ("id", REQ),
    "display_name": (str, REQ),
    "manufacturer": (str, OPT),
    "status": (STATUSES, REQ),
    "support": (SUPPORTS, REQ),
    "capabilities": ({"motor_output": (bool, REQ), "usb_cdc": (bool, REQ), "sd_logging": (bool, REQ)}, REQ),
    "configurator": (CONFIGURATOR_SCHEMA, REQ),
    "mcu": ({"target": ("id", REQ), "part": (str, REQ), "hse_mhz": (int, OPT),
             "flash_kib": (int, OPT), "linker_script": (str, OPT)}, REQ),
    "usb": ({"cdc": (bool, REQ), "dm": ("pin", OPT), "dp": ("pin", OPT)}, REQ),
    "gyro": ({"chip": (str, REQ), "spi_bus": (int, REQ), "cs": ("pin", REQ), "exti": ("pin", OPT),
              "sck": ("pin", OPT), "miso": ("pin", OPT), "mosi": ("pin", OPT),
              "orientation": (ORIENTATIONS, REQ)}, OPT),
    "baro": ({"chip": (str, OPT), "i2c_bus": (int, REQ), "scl": ("pin", REQ), "sda": ("pin", REQ)}, OPT),
    "nor_flash": ({"spi_bus": (int, REQ), "cs": ("pin", REQ), "sck": ("pin", REQ),
                   "miso": ("pin", REQ), "mosi": ("pin", REQ)}, OPT),
    "sd": ({"spi_bus": (int, REQ), "cs": ("pin", REQ), "sck": ("pin", REQ), "miso": ("pin", REQ),
            "mosi": ("pin", REQ), "detect": ("pin", OPT)}, OPT),
    "adc": ({"vbat": ("pin", OPT), "current": ("pin", OPT)}, REQ),
    "motors": (("list", {"index": (int, REQ), "pin": ("pin", REQ), "timer": (str, REQ),
                         "channel": (int, REQ), "dma": (str, OPT)}), REQ),
    "led": ({"led0": ("pin", OPT)}, REQ),
    "beeper": ({"pin": ("pin", REQ), "inverted": (bool, REQ)}, OPT),
    "uarts": (("list", {"uart": (int, REQ), "tx": ("pin", OPT), "rx": ("pin", OPT)}), REQ),
    "receiver": ({"uart": (int, REQ), "tx": ("pin", OPT), "rx": ("pin", OPT), "protocol": (str, REQ)}, OPT),
}


def _check(value, spec, where):
    typ, required = spec
    if value is ABSENT:
        _req(not required, f"{where}: required field missing or absent")
        return
    if isinstance(typ, dict):
        _req(isinstance(value, dict), f"{where}: expected mapping")
        for k in value:
            _req(k in typ, f"{where}: unknown field {k!r}")
        for k, sub in typ.items():
            _req(k in value or not sub[1], f"{where}.{k}: required field missing")
            _check(value.get(k, ABSENT), sub, f"{where}.{k}")
    elif isinstance(typ, tuple) and typ and typ[0] == "list":
        _req(isinstance(value, list), f"{where}: expected list (use [] for none)")
        for i, item in enumerate(value):
            _check(item, (typ[1], REQ), f"{where}[{i}]")
    elif isinstance(typ, tuple):
        _req(value in typ, f"{where}: {value!r} not one of {', '.join(typ)}")
    elif typ == "pin":
        m = PIN_RE.fullmatch(value) if isinstance(value, str) else None
        _req(m is not None and int(m.group(2)) <= 15, f"{where}: invalid pin {value!r}")
    elif typ == "id":
        _req(isinstance(value, str) and ID_RE.fullmatch(value), f"{where}: invalid identifier")
    elif typ is int:
        _req(type(value) is int and value >= 0, f"{where}: expected non-negative integer")
    else:
        _req(type(value) is typ, f"{where}: expected {typ.__name__}")


def _pins(d):
    """Every (owner, pin) claimed by the definition. UART table rows are
    alternatives for one serial port, so the default receiver may repeat its row."""
    out = []
    add = lambda owner, p: p and out.append((owner, p))
    for blk in ("gyro", "baro", "nor_flash", "sd"):
        for k, v in (d.get(blk) or {}).items():
            if k in ("cs", "exti", "sck", "miso", "mosi", "scl", "sda", "detect"):
                add(f"{blk}.{k}", v)
    for k in ("dm", "dp"):
        add(f"usb.{k}", d["usb"].get(k))
    for k in ("vbat", "current"):
        add(f"adc.{k}", d["adc"].get(k))
    add("led.led0", d["led"].get("led0"))
    if d.get("beeper"):
        add("beeper.pin", d["beeper"]["pin"])
    for m in d["motors"]:
        add(f"motors[{m['index']}]", m["pin"])
    for u in d["uarts"]:
        add(f"uart{u['uart']}.tx", u.get("tx"))
        add(f"uart{u['uart']}.rx", u.get("rx"))
    rx = d.get("receiver")
    if rx and not any(u["uart"] == rx["uart"] for u in d["uarts"]):
        add("receiver.tx", rx.get("tx"))
        add("receiver.rx", rx.get("rx"))
    return out


def validate(d: dict, stem: str | None = None) -> dict:
    _req(isinstance(d, dict), "board definition must be a mapping")
    for k in d:
        _req(k in SCHEMA, f"unknown top-level field {k!r}")
    for k, spec in SCHEMA.items():
        _req(k in d, f"{k}: required field missing (write `absent` if the board has none)")
        _check(d[k], spec, k)
    _req(d["schema_version"] == SCHEMA_VERSION, "unsupported schema_version")
    if stem is not None:
        _req(d["board_id"] == stem, f"board_id {d['board_id']!r} must match file name {stem!r}")
    _req(len(d["board_id"]) < 48, "board_id too long")
    _req(d["mcu"]["part"] == d["mcu"]["target"].upper(), "mcu.part must match mcu.target")
    g = d.get("gyro")
    _req(g is None or (0 < len(g["chip"]) <= 23), "gyro.chip length")
    rx = d.get("receiver")
    _req(rx is None or (0 < len(rx["protocol"]) <= 11), "receiver.protocol length")

    # duplicates: pins, timer/channel, motor indices, uart numbers
    seen = {}
    for owner, pin in _pins(d):
        _req(pin not in seen, f"duplicate pin {pin}: {seen.get(pin)} and {owner}")
        seen[pin] = owner
    idx = [m["index"] for m in d["motors"]]
    _req(idx == list(range(1, len(idx) + 1)), "motors must be indexed 1..N in order")
    tc = set()
    for m in d["motors"]:
        _req(re.fullmatch(r"TIM([1-9]|1[0-4])", m["timer"]) is not None, f"motors[{m['index']}].timer invalid")
        _req(1 <= m["channel"] <= 4, f"motors[{m['index']}].channel must be 1..4")
        key = (m["timer"], m["channel"])
        _req(key not in tc, f"duplicate timer use {m['timer']} CH{m['channel']}")
        tc.add(key)
    nums = [u["uart"] for u in d["uarts"]]
    _req(len(nums) == len(set(nums)) and all(1 <= n <= 8 for n in nums), "uarts must be unique 1..8")
    if rx is not None:
        _req(1 <= rx["uart"] <= 8, "receiver.uart must be 1..8")
        row = next((u for u in d["uarts"] if u["uart"] == rx["uart"]), None)
        if row is not None:
            _req(row.get("tx") == rx.get("tx") and row.get("rx") == rx.get("rx"),
                 "receiver pins must equal its uarts row")
    # buses
    buses = {}
    for blk, key in (("gyro", "spi_bus"), ("nor_flash", "spi_bus"), ("sd", "spi_bus")):
        if d.get(blk):
            b = d[blk][key]
            _req(b >= 1, f"{blk}.{key} must be >= 1")
            _req(b not in buses, f"duplicate SPI bus {b}: {buses.get(b)} and {blk}")
            buses[b] = blk
    # Existing driver routing guards (unchanged from the previous IR validator).
    nf = d.get("nor_flash")
    if nf:
        _req(nf["spi_bus"] == 2 and d["mcu"]["part"] == "STM32F722"
             and [nf[k] for k in ("cs", "sck", "miso", "mosi")] == ["PB12", "PB13", "PB14", "PC3"],
             "unsupported flash SPI routing")
    br = d.get("baro")
    if br:
        _req(br["i2c_bus"] == 1 and d["mcu"]["part"] == "STM32F722" and [br["scl"], br["sda"]] == ["PB8", "PB9"],
             "unsupported barometer I2C routing")
    # support / status / capabilities
    caps, sup, st = d["capabilities"], d["support"], d["status"]
    if sup == "host-only":
        _req(not any(caps.values()), "host-only board cannot advertise hardware capabilities")
        _req(st not in PACKABLE, "host-only board must be stub/draft")
    elif sup == "diagnostic":
        _req(not caps["motor_output"] and not caps["sd_logging"], "diagnostic profiles have no motor/SD capability")
    else:
        _req(st in PACKABLE, "hardware target requires a bf-derived/verified IR status")
    if sup == "sensor-only":
        _req(not caps["motor_output"], "sensor-only target cannot advertise motor output")
    if st in PACKABLE and sup != "diagnostic":
        _req(g is not None, "physical board requires a gyro block with exactly one orientation")
    cfg = d["configurator"]
    _req((cfg["image_profile"] == "main") == (sup != "diagnostic"), "configurator.image_profile must match support")
    if sup == "diagnostic":
        for k in ("build_label", "artifact_name", "mcu_display", "support_label"):
            _req(cfg.get(k), f"diagnostic profile requires configurator.{k}")
    else:
        _req(cfg.get("custom") is None and cfg.get("support_label") is None and cfg.get("mcu_display") is None,
             "only diagnostic profiles carry custom/support_label/mcu_display")
        _req(cfg.get("artifact_name") is None, "main builds name their artifact from board_id")
    if cfg.get("artifact_name") is not None:
        _req(re.fullmatch(r"bobflight-[a-z0-9-]+\.hex", cfg["artifact_name"]) is not None, "invalid artifact_name")
    return d


def load(path: Path) -> dict:
    path = Path(path)
    return validate(parse_yaml(path.read_text(encoding="utf-8")), path.stem)


def board_files(root: Path) -> list[Path]:
    return sorted(p for p in (Path(root) / "boards").glob("*.yaml"))


# --------------------------------------------------------------------------- codegen view
def to_ir(d: dict) -> dict:
    """Flat view consumed by ir_codegen.render (same keys as the legacy IR parser)."""
    g = d.get("gyro") or {}
    rx = d.get("receiver") or {}
    nf = d.get("nor_flash") or {}
    br = d.get("baro") or {}
    sd = d.get("sd") or {}
    s = lambda v: v or ""
    return {
        "status": d["status"],
        "board_id": d["board_id"],
        "mcu": d["mcu"]["part"],
        "hse": d["mcu"].get("hse_mhz") or 0,
        "chip": g.get("chip", "none"),
        "spi": g.get("spi_bus", 0),
        "cs": s(g.get("cs")), "exti": s(g.get("exti")),
        "rx_uart": rx.get("uart", 0), "tx": s(rx.get("tx")), "rx": s(rx.get("rx")),
        "proto": rx.get("protocol", "CRSF"),
        "led0": s(d["led"].get("led0")),
        "vbat": s(d["adc"].get("vbat")), "current": s(d["adc"].get("current")),
        "sck": s(g.get("sck")), "miso": s(g.get("miso")), "mosi": s(g.get("mosi")),
        "align": g.get("orientation", "CW0_DEG"),
        "motors": [{"index": m["index"], "pin": m["pin"], "timer": m["timer"], "channel": m["channel"]}
                   for m in d["motors"]],
        "baro_i2c": br.get("i2c_bus", 0), "baro_pins": [s(br.get("scl")), s(br.get("sda"))],
        "flash_spi": nf.get("spi_bus", 0),
        "flash_pins": [s(nf.get(k)) for k in ("cs", "sck", "miso", "mosi")],
        "sd_spi": sd.get("spi_bus", 0),
        "sd_cs": s(sd.get("cs")), "sd_sck": s(sd.get("sck")), "sd_miso": s(sd.get("miso")),
        "sd_mosi": s(sd.get("mosi")), "sd_detect": s(sd.get("detect")),
        "uarts": [{"uart": u["uart"], "tx": s(u.get("tx")), "rx": s(u.get("rx"))} for u in d["uarts"]],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate BobFlight board definitions")
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--json", action="store_true", help="print the parsed definitions")
    a = ap.parse_args()
    files = a.files or board_files(a.root)
    out, bad = {}, 0
    for f in files:
        try:
            out[f.stem] = load(f)
        except (BoardDefError, OSError) as e:
            bad += 1
            print(f"FAIL {f}: {e}", file=sys.stderr)
    if a.json:
        print(json.dumps(out, indent=2))
    if bad:
        return 2
    print(f"PASS {len(out)} board definitions: {', '.join(out)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
