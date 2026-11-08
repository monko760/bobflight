#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.
"""Offline installer tests. Only a TEMPORARY script copy receives fixture hashes.
Production's official URL and SHA-256 remain hardcoded; no network is used here.
"""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('setup-arm-toolchain.sh')

class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'fake-bin'
        self.bin.mkdir()
        self.log = self.root / 'curl.log'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        RUNNER_TOOL_CACHE=str(self.root / 'cache'),
                        RUNNER_TEMP=str(self.root / 'temp'),
                        GITHUB_PATH=str(self.root / 'github-path'),
                        GITHUB_OUTPUT=str(self.root / 'github-output'),
                        CURL_LOG=str(self.log), MOCK_OS='Linux', MOCK_ARCH='x86_64', CURL_MODE='ok')
        self.exe(self.bin / 'uname', '#!/bin/sh\ncase "$1" in -s) echo "$MOCK_OS";; -m) echo "$MOCK_ARCH";; esac\n')
        self.exe(self.bin / 'curl', '''#!/usr/bin/env python3
import os, pathlib, shutil, sys
args=sys.argv[1:]
with open(os.environ['CURL_LOG'],'a') as f:f.write(repr(args)+'\\n')
assert args[args.index('--proto')+1]=='=https'
assert args[args.index('--proto-redir')+1]=='=https'
assert args[args.index('--connect-timeout')+1]=='20'
assert args[args.index('--max-time')+1]=='150'
assert args[args.index('--retry-max-time')+1]=='360'
assert args[-1].startswith('https://developer.arm.com/')
if os.environ['CURL_MODE']=='fail':sys.exit(28)
out=args[args.index('--output')+1]
if os.environ['CURL_MODE']=='bad':pathlib.Path(out).write_bytes(b'bad download')
else:shutil.copyfile(os.environ['FIXTURE'],out)
''')
        self.fixture()

    def exe(self, path, text):
        path.write_text(text)
        path.chmod(0o755)

    def fixture(self, version='14.2.1', missing_library=False, missing_tool=False):
        tree = self.root / 'tree'
        (tree / 'bin').mkdir(parents=True, exist_ok=True)
        (tree / 'lib').mkdir(exist_ok=True)
        for lib in ['nosys.specs', 'libc.a', 'libm.a', 'libnosys.a', 'libgcc.a']:
            p = tree / 'lib' / lib
            if missing_library and lib == 'nosys.specs':p.unlink(missing_ok=True)
            else:p.write_text('fixture')
        self.exe(tree / 'bin' / 'arm-none-eabi-gcc', '''#!/bin/sh
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
printf 'executed\\n' >> "$root/executed"
case "$1" in
 -dumpfullversion) echo 'VERSION';;
 --version) echo 'Fixture GCC VERSION';;
 *) for arg in "$@"; do case "$arg" in -print-file-name=*) echo "$root/lib/${arg#*=}";; esac; done;;
esac
'''.replace('VERSION',version))
        for tool in ['g++', 'objcopy', 'objdump', 'readelf', 'size', 'nm', 'ar']:
            p=tree/'bin'/('arm-none-eabi-'+tool)
            if missing_tool and tool=='objcopy':p.unlink(missing_ok=True)
            else:self.exe(p,'#!/bin/sh\nexit 0\n')
        archive=self.root/'fixture.tar.xz'
        with tarfile.open(archive,'w:xz') as t:t.add(tree,arcname='arm-gnu-toolchain-fixture')
        self.env['FIXTURE']=str(archive)
        fixture_hash=hashlib.sha256(archive.read_bytes()).hexdigest()
        text,n=re.subn(r"^SHA256='[0-9a-f]{64}'$", "SHA256='"+fixture_hash+"'", SCRIPT.read_text(),flags=re.M)
        self.assertEqual(n,1)
        self.test_script=self.root/'installer.sh'
        self.test_script.write_text(text)

    def run_installer(self, ok=True):
        result=subprocess.run(['bash',str(self.test_script)],env=self.env,text=True,capture_output=True,timeout=10)
        if ok:self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        else:self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        return result

    def test_cold_then_warm_reverifies_and_extracts_fresh(self):
        self.run_installer()
        first=Path((self.root/'github-path').read_text().splitlines()[-1])
        self.exe(first/'arm-none-eabi-gcc','#!/bin/sh\nexit 99\n')
        result=self.run_installer()
        second=Path((self.root/'github-path').read_text().splitlines()[-1])
        self.assertNotEqual(first,second)
        self.assertIn('checksum-verified cached',result.stdout)
        self.assertEqual(len(self.log.read_text().splitlines()),1)
        self.assertIn('version=14.2.rel1',(self.root/'github-output').read_text())

    def test_corrupt_cache_downloads_verified_replacement(self):
        self.run_installer()
        archive=self.root/'cache/bobflight-arm-gnu/arm-gnu-toolchain.tar.xz'
        archive.write_bytes(b'tampered cache')
        result=self.run_installer()
        self.assertIn('Cached ARM archive failed checksum',result.stderr)
        self.assertEqual(len(self.log.read_text().splitlines()),2)
        self.assertEqual(archive.read_bytes(),Path(self.env['FIXTURE']).read_bytes())

    def test_bad_download_not_extracted_or_exported(self):
        self.env['CURL_MODE']='bad'
        result=self.run_installer(False)
        self.assertIn('refusing extraction',result.stderr)
        self.assertFalse((self.root/'github-path').exists())
        self.assertEqual(list((self.root/'temp').iterdir()),[])
        self.assertEqual(list((self.root/'cache/bobflight-arm-gnu').iterdir()),[])

    def test_download_failure_cleans_partial_file(self):
        self.env['CURL_MODE']='fail'
        self.run_installer(False)
        self.assertFalse((self.root/'github-path').exists())
        self.assertEqual(list((self.root/'cache/bobflight-arm-gnu').iterdir()),[])

    def test_missing_newlib_fails_before_path_export(self):
        self.fixture(missing_library=True)
        result=self.run_installer(False)
        self.assertIn('Required cortex-m4 library missing',result.stderr)
        self.assertFalse((self.root/'github-path').exists())
        self.assertEqual(list((self.root/'temp').iterdir()),[])

    def test_wrong_compiler_version_fails(self):
        self.fixture(version='13.3.1')
        result=self.run_installer(False)
        self.assertIn('compiler version does not match',result.stderr)
        self.assertFalse((self.root/'github-path').exists())

    def test_missing_tool_fails(self):
        self.fixture(missing_tool=True)
        self.run_installer(False)
        self.assertFalse((self.root/'github-path').exists())

    def test_unsupported_platform_never_downloads(self):
        self.env['MOCK_ARCH']='aarch64'
        self.run_installer(False)
        self.assertFalse(self.log.exists())

if __name__=='__main__':unittest.main(verbosity=2)
