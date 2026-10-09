#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Actual generator must preserve clean checkouts under Windows newline settings."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    'bobflight-configurator/protocol/src/flasher/board-targets.generated.ts',
    'bobflight-configurator/ui/src/targets/catalog.generated.json',
]

def checked(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise AssertionError(f'{args[0]} failed: {result.stdout}\n{result.stderr}')
    return result.stdout

revision = checked(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).strip()
for autocrlf in ('true', 'false', 'input'):
    with tempfile.TemporaryDirectory(prefix='bobflight-catalog-newlines-') as temp:
        checkout = Path(temp)
        # Independent Git config/index. Never change the owner's repository config.
        checked(['git', 'clone', '--quiet', '--no-checkout', '--shared', str(ROOT), temp])
        def git(*args):
            return checked(['git', '-C', temp, *args])
        git('config', 'core.autocrlf', autocrlf)
        git('config', 'core.safecrlf', 'warn')
        git('checkout', '--quiet', '--detach', revision)
        assert git('status', '--porcelain') == '', 'Fixture must begin clean'
        before = {}
        for name in FILES:
            assert git('check-attr', 'eol', '--', name).strip().endswith(': lf'), name
            before[name] = (checkout / name).read_bytes()
            assert b'\r\n' not in before[name], f'Unexpected CRLF: {name}'
        env = dict(os.environ, PYTHON=sys.executable)
        # Two launches: preserve exact bytes and status, not only an empty text diff.
        for _ in range(2):
            checked(['node', str(checkout / 'bobflight-configurator/scripts/generate-target-catalog.cjs')], env=env)
            assert git('status', '--porcelain', '--untracked-files=normal') == '', 'Startup dirtied source'
            for name in FILES:
                assert (checkout / name).read_bytes() == before[name], name
        # Do not solve this by hiding generated files from source verification.
        for name in FILES:
            p = checkout / name
            p.write_bytes(before[name] + b'\n')
            assert name in git('status', '--porcelain'), 'A genuine edit must remain visible'
            p.write_bytes(before[name])
        assert git('status', '--porcelain') == ''
        print(f'PASS core.autocrlf={autocrlf}: LF checkout, repeated generation clean, real edits detected')
