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
PIN_RE = re.compile(r"P([A-K])(1[0-5]|[0-9])")  # no leading zeros: PA09 is not PA9
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


# Driver allowlists: src/drivers/gyro.c probes, src/drivers/bmp280.c, src/drivers/crsf.c.
GYRO_CHIPS = ("MPU6000", "ICM42688", "BMI270")
BARO_CHIPS = ("BMP280",)
RX_PROTOCOLS = ("CRSF",)
# General-purpose/advanced timers and their capture/compare channel counts, identical on
# STM32F405 (RM0090), STM32F722 (RM0431) and STM32F745 (RM0385). TIM6/TIM7 are basic
# timers without channels and are therefore absent.
_F4F7_TIMERS = {"TIM1": 4, "TIM2": 4, "TIM3": 4, "TIM4": 4, "TIM5": 4, "TIM8": 4, "TIM9": 2,
                "TIM10": 1, "TIM11": 1, "TIM12": 2, "TIM13": 1, "TIM14": 1}
# Per-part maxima from the reference manuals / datasheets above (largest package; the
# schema carries no package, so a pin that exists only on bigger packages is not caught).
MCU_RESOURCES = {
    "STM32F405": {"ports": "ABCDEFGHI", "spi": 3, "i2c": 3, "uart": 6, "timers": _F4F7_TIMERS},
    "STM32F722": {"ports": "ABCDEFGHI", "spi": 5, "i2c": 3, "uart": 8, "timers": _F4F7_TIMERS},
    "STM32F745": {"ports": "ABCDEFGHIJK", "spi": 6, "i2c": 4, "uart": 8, "timers": _F4F7_TIMERS},
}
# targets/mcus/*.json (check_tree also requires the JSON to exist).
KNOWN_MCU_TARGETS = ("stm32f405", "stm32f411", "stm32f722", "stm32f745", "stm32h743")
HSE_MHZ = (4, 26)          # F4/F7 datasheets: 4-26 MHz HSE oscillator
DMA_RE = re.compile(r"DMA([12])_S([0-7])")   # stream form; DMA stays absent unless verified
STR_MAX = 200


# --------------------------------------------------------------------------- YAML subset
def _scalar(tok: str):
    t = tok.strip()
    _req(t != "", "empty value (write `absent`)")
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
        inner = t[1:-1]
        _req(not any(c in inner for c in "\"'\\"), f"quotes/backslashes not allowed inside strings: {t!r}")
        return inner
    if t in ("true", "false"):
        return t == "true"
    if t == "absent":
        return ABSENT
    _req(re.fullmatch(r"-?0\d+", t) is None, f"ambiguous scalar {t!r} (leading zero)")
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    _req(t.lower() not in ("null", "~", "yes", "no", "on", "off", "y", "n", "true", "false"), f"ambiguous scalar {t!r}")
    _req(re.fullmatch(r"[0-9.:_+-]+", t) is None, f"ambiguous scalar {t!r} (number-like)")
    _req(not any(c in t for c in "{}[],&*!|>%@`\"\\"), f"unsupported scalar {t!r}")
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
    "gyro": ({"chip": (GYRO_CHIPS, REQ), "spi_bus": (int, REQ), "cs": ("pin", REQ), "exti": ("pin", OPT),
              "sck": ("pin", OPT), "miso": ("pin", OPT), "mosi": ("pin", OPT),
              "orientation": (ORIENTATIONS, REQ)}, OPT),
    "baro": ({"chip": (BARO_CHIPS, OPT), "i2c_bus": (int, REQ), "scl": ("pin", REQ), "sda": ("pin", REQ)}, OPT),
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
    "receiver": ({"uart": (int, REQ), "tx": ("pin", OPT), "rx": ("pin", OPT), "protocol": (RX_PROTOCOLS, REQ)}, OPT),
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
        if typ is str:
            _req(value not in ("", "absent"), f"{where}: empty or quoted 'absent' string (write bare `absent`)")
            _req(len(value) <= STR_MAX, f"{where}: string too long")


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
    _req(d["mcu"]["target"] in KNOWN_MCU_TARGETS, f"mcu.target {d['mcu']['target']!r} is not a known MCU target")
    res = MCU_RESOURCES.get(d["mcu"]["part"])
    hse = d["mcu"].get("hse_mhz")
    _req(hse is None or HSE_MHZ[0] <= hse <= HSE_MHZ[1], f"mcu.hse_mhz {hse} outside {HSE_MHZ[0]}..{HSE_MHZ[1]} MHz")
    g = d.get("gyro")   # chip/protocol lengths are bounded by the driver allowlists
    rx = d.get("receiver")

    # duplicates: pins, timer/channel, motor indices, uart numbers
    seen = {}
    pins = _pins(d)
    if pins or d["motors"] or d["uarts"] or rx is not None or g is not None:
        _req(res is not None, f"no verified resource table for {d['mcu']['part']}: pins, buses and timers cannot be checked")
    for owner, pin in pins:
        _req(pin[1] in res["ports"], f"{owner}: {pin} is on port {pin[1]}, which {d['mcu']['part']} does not have")
        _req(pin not in seen, f"duplicate pin {pin}: {seen.get(pin)} and {owner}")
        seen[pin] = owner
    idx = [m["index"] for m in d["motors"]]
    _req(idx == list(range(1, len(idx) + 1)), "motors must be indexed 1..N in order")
    dmas = {}
    for m in d["motors"]:
        dm = m.get("dma")
        if dm is not None:
            _req(DMA_RE.fullmatch(dm) is not None, f"motors[{m['index']}].dma {dm!r} must look like DMA1_S2")
            _req(dm not in dmas, f"duplicate DMA stream {dm}: motors[{dmas.get(dm)}] and motors[{m['index']}]")
            dmas[dm] = m["index"]
    tc = set()
    for m in d["motors"]:
        _req(re.fullmatch(r"TIM([1-9]|1[0-4])", m["timer"]) is not None, f"motors[{m['index']}].timer invalid")
        _req(1 <= m["channel"] <= res["timers"].get(m["timer"], 0),
             f"motors[{m['index']}]: {m['timer']} has no channel {m['channel']} on {d['mcu']['part']}")
        key = (m["timer"], m["channel"])
        _req(key not in tc, f"duplicate timer use {m['timer']} CH{m['channel']}")
        tc.add(key)
    nums = [u["uart"] for u in d["uarts"]]
    _req(len(nums) == len(set(nums)), "duplicate uart in uarts")
    for n in nums:
        _req(1 <= n <= res["uart"], f"uart {n} does not exist on {d['mcu']['part']} (1..{res['uart']})")
    if rx is not None:
        _req(1 <= rx["uart"] <= res["uart"], f"receiver.uart {rx['uart']} does not exist on {d['mcu']['part']}")
        row = next((u for u in d["uarts"] if u["uart"] == rx["uart"]), None)
        _req(row is not None or not d["uarts"], f"receiver.uart {rx['uart']} is not in the uarts table")
        if row is not None:
            _req(row.get("tx") == rx.get("tx") and row.get("rx") == rx.get("rx"),
                 "receiver pins must equal its uarts row")
    # buses
    buses = {}
    for blk, key in (("gyro", "spi_bus"), ("nor_flash", "spi_bus"), ("sd", "spi_bus")):
        if d.get(blk):
            b = d[blk][key]
            _req(1 <= b <= res["spi"], f"{blk}.{key} {b} does not exist on {d['mcu']['part']} (1..{res['spi']})")
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
        _req(1 <= br["i2c_bus"] <= res["i2c"], f"baro.i2c_bus {br['i2c_bus']} does not exist on {d['mcu']['part']}")
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
    if sup != "host-only":
        _req(d["usb"]["cdc"] == caps["usb_cdc"], "usb.cdc must equal capabilities.usb_cdc")
    _req(not caps["motor_output"] or d["motors"], "capabilities.motor_output requires motors")
    _req(not caps["sd_logging"] or d.get("sd") is not None, "capabilities.sd_logging requires an sd block")
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
        _req(cfg.get("menu_order") is None, "menu_order applies to diagnostic profiles only")
    if cfg.get("artifact_name") is not None:
        _req(re.fullmatch(r"bobflight-[a-z0-9-]+\.hex", cfg["artifact_name"]) is not None, "invalid artifact_name")
    return d


def check_tree(d: dict, root: Path) -> dict:
    """Checks that need the firmware tree: MCU definition and linker script."""
    root = Path(root).resolve()
    _req((root / "targets/mcus" / f"{d['mcu']['target']}.json").is_file(),
         f"mcu.target {d['mcu']['target']!r} has no targets/mcus definition")
    ls = d["mcu"].get("linker_script")
    if ls is not None:
        _req(re.fullmatch(r"cmake/[A-Za-z0-9_./-]+\.ld", ls) is not None and ".." not in ls.split("/"),
             f"mcu.linker_script {ls!r} must be a cmake/*.ld path inside the tree")
        _req((root / ls).resolve().is_file(), f"mcu.linker_script {ls!r} does not exist")
    return d


def load(path: Path, root: Path | None = None) -> dict:
    path = Path(path)
    d = validate(parse_yaml(path.read_text(encoding="utf-8")), path.stem)
    return check_tree(d, Path(root) if root else path.resolve().parent.parent)


def board_files(root: Path) -> list[Path]:
    """Every entry in boards/ must be a <board_id>.yaml file (README.md excepted)."""
    out = []
    for p in sorted((Path(root) / "boards").iterdir()):
        if p.name == "README.md":
            continue
        _req(p.is_file() and p.suffix == ".yaml" and ID_RE.fullmatch(p.stem) is not None,
             f"boards/{p.name}: only <board_id>.yaml files belong in boards/ (no .yml, subdirectories or other files)")
        out.append(p)
    return out


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
        "flash_kib": d["mcu"].get("flash_kib") or 0,
        "flash_pins": [s(nf.get(k)) for k in ("cs", "sck", "miso", "mosi")],
        "sd_spi": sd.get("spi_bus", 0),
        "sd_cs": s(sd.get("cs")), "sd_sck": s(sd.get("sck")), "sd_miso": s(sd.get("miso")),
        "sd_mosi": s(sd.get("mosi")), "sd_detect": s(sd.get("detect")),
        "uarts": [{"uart": u["uart"], "tx": s(u.get("tx")), "rx": s(u.get("rx"))} for u in d["uarts"]],
    }


def check_set(defs) -> None:
    """Cross-file rules: display names are unique across boards and diagnostic profiles."""
    seen = {}
    for d in defs:
        name = d["display_name"]
        _req(name not in seen, f"duplicate display_name {name!r}: {seen.get(name)} and {d['board_id']}")
        seen[name] = d["board_id"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate BobFlight board definitions")
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--json", action="store_true", help="print the parsed definitions")
    a = ap.parse_args()
    try:
        files = a.files or board_files(a.root)
    except BoardDefError as e:
        print(f"FAIL {e}", file=sys.stderr)
        return 2
    out, bad = {}, 0
    for f in files:
        try:
            out[f.stem] = load(f)
        except (BoardDefError, OSError) as e:
            bad += 1
            print(f"FAIL {f}: {e}", file=sys.stderr)
    try:
        check_set(out.values())
    except BoardDefError as e:
        bad += 1
        print(f"FAIL {e}", file=sys.stderr)
    if a.json:
        print(json.dumps(out, indent=2))
    if bad:
        return 2
    print(f"PASS {len(out)} board definitions: {', '.join(out)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
