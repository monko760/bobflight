# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Real host executable dispatch/framing; no hardware performance claims."""
import subprocess,sys
p=subprocess.run([sys.argv[1]],input="timing_profile start\ntiming_profile\ntiming_profile stop\n",text=True,capture_output=True,timeout=15)
assert p.returncode==0,p.stderr
assert p.stdout.count("timing_profile_end: 1")==3,p.stdout
assert "profile_state: running" in p.stdout,p.stdout
assert "profile_state: stopped" in p.stdout,p.stdout
assert "timing_profile_version: 1" in p.stdout and "response-overflow" not in p.stdout,p.stdout
assert "unknown" not in p.stdout,p.stdout
print("PASS real host CLI: start/read/stop dispatch and three complete framed responses")
