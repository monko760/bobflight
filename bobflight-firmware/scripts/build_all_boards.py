#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Build every boards/<board_id>.yaml and fail if any board does not build.

Build only. Never accesses, erases or flashes a device.

Each board uses the recipe the repository already has for it (the same recipes the
Configurator local HEX builder runs), chosen from its board definition:

  support host-only        -> host build of bobflight_host; no device HEX (the target
                              registry refuses host-only targets for hardware builds)
  support diagnostic       -> tools/build_f405_usb_diagnostic.py, published as
                              configurator.artifact_name
  anything else (main)     -> CMake cross build with the MCU toolchain from the target
                              registry, check_bootloader_image, then
                              scripts/publish_target_image.py (HEX + provenance manifest)

Output contract (docs/BOARDS.md, "Building every board"):

  <out>/boards.json                                   every board, its result, and the
                                                      "flashable" list (board ids + paths)
  <out>/hex/<board_id>/bobflight-<board_id>-main.hex   main images
  <out>/hex/<board_id>/bobflight-<board_id>-main.hex.json   provenance manifest (main only)
  <out>/hex/<board_id>/<configurator.artifact_name>    diagnostic images
  <out>/logs/<board_id>.log                           build log per board
  <out>/work/<board_id>/                    build trees (not part of the contract)

<out> must be new or empty, so an older HEX can never be mistaken for this build.
Board identity metadata inside the HEX (PR C) is not added here; it is planned to join
this pipeline later.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import board_def  # noqa: E402
from target_registry import TargetRegistry, TargetRegistryError  # noqa: E402

FIRMWARE = SCRIPTS.parent
# Same cache options as bobflight-configurator/scripts/local-hex-builder.mjs main builds.
MAIN_CMAKE_OPTIONS = ['-DBOBFLIGHT_HOST_SMOKE=OFF', '-DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF',
                      '-DBOBFLIGHT_PROVE_RESET=OFF', '-DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF']
FLASH_BASE = 0x08000000


class BuildError(RuntimeError):
    pass


def run(cmd, log, cwd=None):
    """Run one build command, appending its output to the board log."""
    with open(log, 'a', encoding='utf-8') as f:
        f.write('$ ' + ' '.join(str(c) for c in cmd) + '\n')
        f.flush()
        r = subprocess.run([str(c) for c in cmd], cwd=cwd, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise BuildError(f'{Path(str(cmd[0])).name} exited {r.returncode} (see {log})')


def board_yaml_ids(root: Path) -> list[str]:
    """Independent of the loaders: every *.yaml in boards/ must get a result."""
    return sorted(p.stem for p in (root / 'boards').glob('*.yaml'))


def plan(root: Path = FIRMWARE) -> list[dict]:
    """One entry per boards/*.yaml. Raises on any invalid definition (nothing is built)."""
    registry = TargetRegistry(root)
    entries = []
    for path in board_def.board_files(root):
        d = board_def.load(path)
        bid, support = d['board_id'], d['support']
        cfg = d['configurator']
        entry = {'board_id': bid, 'display_name': d['display_name'], 'support': support,
                 'image_profile': cfg['image_profile'], 'mcu': d['mcu']['part'].lower()}
        if support == 'host-only':
            entry.update(recipe='host', hex=None)  # registry: host-only cannot produce hardware firmware
        elif support == 'diagnostic':
            if cfg['image_profile'] != 'f405-usb-diagnostic':
                raise BuildError(f'{bid}: no build recipe for diagnostic image_profile {cfg["image_profile"]}')
            entry.update(recipe='f405-usb-diagnostic', hex=f'hex/{bid}/{cfg["artifact_name"]}',
                         flash_kib=d['mcu']['flash_kib'])
        else:
            if cfg['image_profile'] != 'main':
                raise BuildError(f'{bid}: no build recipe for image_profile {cfg["image_profile"]}')
            try:
                resolved = registry.resolve(bid, hardware=True)
            except TargetRegistryError as e:
                raise BuildError(f'{bid}: {e}') from e
            entry.update(recipe='main', hex=f'hex/{bid}/bobflight-{bid}-main.hex', toolchain=resolved['toolchain'])
        entries.append(entry)
    missing = sorted(set(board_yaml_ids(root)) - {e['board_id'] for e in entries})
    if missing:
        raise BuildError('boards without a build entry: ' + ', '.join(missing))
    return entries


def flashable(entries) -> list[dict]:
    """Boards that get a device HEX, sorted by board_id. Host-only boards never appear."""
    return [{'board_id': e['board_id'], 'image_profile': e['image_profile'], 'hex': e['hex']}
            for e in sorted(entries, key=lambda e: e['board_id']) if e['hex']]


def check_intel_hex(path: Path, flash_kib) -> int:
    """Checksums, EOF and every byte inside [FLASH_BASE, FLASH_BASE + flash_kib KiB)."""
    upper, count, eof = 0, 0, False
    limit = FLASH_BASE + int(flash_kib) * 1024
    for number, line in enumerate(path.read_text(encoding='ascii').splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        if eof or not line.startswith(':'):
            raise BuildError(f'{path.name}: invalid HEX line {number}')
        rec = bytes.fromhex(line[1:])
        if len(rec) < 5 or len(rec) != rec[0] + 5 or sum(rec) & 255:
            raise BuildError(f'{path.name}: bad length/checksum on line {number}')
        kind, addr = rec[3], int.from_bytes(rec[1:3], 'big')
        if kind == 0:
            start = upper + addr
            if not (FLASH_BASE <= start and start + rec[0] <= limit):
                raise BuildError(f'{path.name}: data outside {flash_kib} KiB flash on line {number}')
            count += rec[0]
        elif kind == 1:
            eof = True
        elif kind == 4:
            upper = int.from_bytes(rec[4:6], 'big') << 16
    if not eof or not count:
        raise BuildError(f'{path.name}: missing EOF or empty image')
    return count


def build_host(entry, work: Path, log: Path, jobs: int):
    run(['cmake', '-S', FIRMWARE, '-B', work, f'-DBOBFLIGHT_BOARD={entry["board_id"]}'], log)
    run(['cmake', '--build', work, '--target', 'bobflight_host', '-j', jobs], log)
    exe = work / ('bobflight_host.exe' if os.name == 'nt' else 'bobflight_host')
    if not exe.is_file():
        raise BuildError(f'host build produced no {exe.name}')


def build_diagnostic(entry, work: Path, log: Path, jobs: int, dest: Path):
    run([sys.executable, FIRMWARE / 'tools/build_f405_usb_diagnostic.py', '--out', work], log)
    hexes = sorted(work.glob('*.hex'))
    if len(hexes) != 1:
        raise BuildError(f'diagnostic build produced {len(hexes)} HEX files, expected exactly 1')
    check_intel_hex(hexes[0], entry['flash_kib'])
    shutil.copyfile(hexes[0], dest)


def build_main(entry, work: Path, log: Path, jobs: int, dest: Path):
    import publish_target_image  # needs git; imported only for hardware builds
    bid = entry['board_id']
    run(['cmake', '-S', FIRMWARE, '-B', work, f'-DCMAKE_TOOLCHAIN_FILE={FIRMWARE / entry["toolchain"]}',
         f'-DBOBFLIGHT_BOARD={bid}', *MAIN_CMAKE_OPTIONS], log)
    run(['cmake', '--build', work, '-j', jobs], log)
    run(['cmake', '--build', work, '--target', 'check_bootloader_image'], log)
    image = work / 'bobflight.hex'
    if not image.is_file():
        raise BuildError('build produced no bobflight.hex')
    with tempfile.TemporaryDirectory(prefix='publish-', dir=work) as staging:
        published = publish_target_image.publish(bid, image, staging)
        src = Path(published['directory'])
        name = published['manifest']['file']
        if name != dest.name:
            raise BuildError(f'publisher named the image {name}, expected {dest.name}')
        shutil.copyfile(src / name, dest)
        shutil.copyfile(src / (name + '.json'), dest.parent / (name + '.json'))


BUILDERS = {'host': build_host, 'f405-usb-diagnostic': build_diagnostic, 'main': build_main}


def git_state():
    repo = FIRMWARE.parent
    try:
        commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
        dirty = bool(subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain',
                                              '--untracked-files=no'], text=True).strip())
        return commit, dirty
    except (OSError, subprocess.CalledProcessError):
        return None, None


def build_all(out: Path, jobs: int, root: Path = FIRMWARE) -> int:
    out = Path(out).resolve()
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        print(f'all-boards: {out} is not empty; choose a new or empty directory '
              '(an older HEX must never be mistaken for this build)', file=sys.stderr)
        return 2
    try:
        entries = plan(root)
    except (BuildError, ValueError, OSError) as e:
        print(f'all-boards: FAIL board definitions: {e}', file=sys.stderr)
        return 2
    logs = out / 'logs'
    for d in (out / 'hex', logs, out / 'work'):
        d.mkdir(parents=True, exist_ok=True)
    results = []
    for entry in entries:
        bid = entry['board_id']
        log = logs / f'{bid}.log'
        log.write_text('', encoding='utf-8')
        result = {k: entry[k] for k in ('board_id', 'display_name', 'support', 'image_profile', 'mcu')}
        result.update(hex=None, sha256=None, manifest=None)
        print(f'all-boards: {bid} ({entry["recipe"]}) ...', flush=True)
        try:
            builder = BUILDERS[entry['recipe']]
            work = out / 'work' / bid
            if entry['recipe'] == 'host':
                builder(entry, work, log, jobs)
                result['result'] = 'host-build'
            else:
                image = out / entry['hex']
                image.parent.mkdir(parents=True, exist_ok=True)
                builder(entry, work, log, jobs, image)
                if not image.is_file() or image.stat().st_size == 0:
                    raise BuildError(f'expected HEX {entry["hex"]} is missing')
                result.update(result='hex', hex=entry['hex'],
                              sha256=hashlib.sha256(image.read_bytes()).hexdigest())
                if entry['recipe'] == 'main':
                    if not (out / (entry['hex'] + '.json')).is_file():
                        raise BuildError(f'expected manifest {entry["hex"]}.json is missing')
                    result['manifest'] = entry['hex'] + '.json'
        except (BuildError, ValueError, OSError, RuntimeError, subprocess.SubprocessError) as e:
            result.update(result='failed', error=str(e), hex=None, sha256=None, manifest=None)
            if entry.get('hex'):
                for f in (entry['hex'], entry['hex'] + '.json'):
                    (out / f).unlink(missing_ok=True)  # never leave a partial pair
        result['log'] = f'logs/{bid}.log'
        print(f'all-boards: {bid}: {result["result"]}' + (f' ({result["error"]})' if 'error' in result else ''),
              flush=True)
        results.append(result)
    expected = board_yaml_ids(root)
    seen = sorted(r['board_id'] for r in results)
    ok = all(r['result'] in ('hex', 'host-build') for r in results) and seen == expected
    commit, dirty = git_state()
    sha = {r['board_id']: r['sha256'] for r in results}
    index = {'schema_version': 1, 'ok': ok, 'git_commit': commit, 'tracked_source_dirty': dirty,
             'flashable': [dict(f, sha256=sha[f['board_id']]) for f in flashable(entries)],
             'boards': results}
    (out / 'boards.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
    built = [r['board_id'] for r in results if r['result'] == 'hex']
    failed = [r['board_id'] for r in results if r['result'] == 'failed']
    print(f'all-boards: {len(results)} boards; HEX: {", ".join(built) or "none"}; '
          f'host-only: {", ".join(r["board_id"] for r in results if r["result"] == "host-build") or "none"}')
    if not ok:
        print(f'all-boards: FAIL {", ".join(failed) or "board set mismatch"}', file=sys.stderr)
        return 1
    print(f'all-boards: PASS -> {out / "boards.json"}')
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--out', type=Path, default=FIRMWARE / 'build-all-boards',
                   help='new or empty output directory (default: bobflight-firmware/build-all-boards)')
    p.add_argument('--jobs', '-j', type=int, default=os.cpu_count() or 2)
    p.add_argument('--plan', action='store_true', help='print the per-board recipe as JSON and build nothing')
    p.add_argument('--list-flashable', action='store_true',
                   help='print the expected flashable list (same shape as boards.json "flashable") and build nothing')
    a = p.parse_args(argv)
    if a.plan or a.list_flashable:
        try:
            entries = plan()
            print(json.dumps({'schema_version': 1, 'flashable': flashable(entries)} if a.list_flashable
                             else entries, indent=2))
            return 0
        except (BuildError, ValueError, OSError) as e:
            print(f'all-boards: FAIL board definitions: {e}', file=sys.stderr)
            return 2
    return build_all(a.out, a.jobs)


if __name__ == '__main__':
    sys.exit(main())
