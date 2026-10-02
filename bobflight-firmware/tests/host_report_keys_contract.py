# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Report contract (safety S1): the real host firmware's `status`, `filters`,
`loop_rate` and `receiver` replies keep exactly the keys, in the same order,
that b77b845 (main before S1) sends for the same board. Values may differ
(e.g. filters_sample_hz is the gyro rate since S1); keys and order may not.
`rpm_filter` is not on b77b845; its keys in the golden were captured from
the #60 tip 04769f9 (feat/rpm-filter, before S1) host builds, and are checked
the same way. A report recorded as null in the golden would be skipped.

Golden: tests/golden/report_keys_b77b845.json, captured from b77b845 host
builds of each board with:  python3 host_report_keys_contract.py --capture <bobflight_host> <board>
Usage (ctest):  python3 host_report_keys_contract.py <bobflight_host> <board>"""
import json, os, subprocess, sys

REPORTS = ['status', 'filters', 'loop_rate', 'receiver', 'rpm_filter']
SEP = 'zz_report_sep'                       # unknown command -> "unknown — try help"
UNKNOWN = 'unknown \u2014 try help'
GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'golden', 'report_keys_b77b845.json')

def capture(exe):
    cmds = []
    for r in REPORTS:
        cmds += [r, SEP]
    out = subprocess.run([exe], input=('\n'.join(cmds) + '\n').encode(), stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=60, check=True).stdout.decode('utf-8')
    lines = out.split('\r\n')
    # Drop the banner (everything up to the "... ready" line).
    start = next(i for i, l in enumerate(lines) if l.endswith(' ready')) + 1
    blocks, cur = [], []
    for l in lines[start:]:
        if l == UNKNOWN:
            blocks.append(cur); cur = []
        elif l:
            cur.append(l)
    assert len(blocks) >= len(REPORTS), (len(blocks), out[:2000])
    res = {}
    # Each report's lines end at its separator's "unknown" line; an absent
    # report prints its own "unknown" line first, i.e. one extra empty block.
    i = 0
    for r in REPORTS:
        blk = blocks[i]; i += 1
        if not blk:                          # the report itself was unknown
            res[r] = None
            i += 1                           # skip the separator's (empty) block
            continue
        keys = []
        for l in blk:
            k, sep, _ = l.partition(': ')
            assert sep, f'{r}: line without "key: value": {l!r}'
            keys.append(k)
        res[r] = keys
    return res

# S3 (fix/gyro-sanity, frozen spec): `status` gains exactly two keys,
# gyro_health then gyro_sat_count, immediately after gyro_ok. The b77b845
# golden is NOT re-captured: the expected key list is the golden with exactly
# these two keys inserted at exactly that place, so any other status key/order
# change still fails.
S3_GYRO_STATUS_KEYS = ['gyro_health', 'gyro_sat_count']

def s3_expected_status(golden):
    keys = golden['status']
    assert keys.count('gyro_ok') == 1, keys
    assert not set(S3_GYRO_STATUS_KEYS) & set(keys), 'golden already has S3 keys'
    i = keys.index('gyro_ok') + 1
    print('NOTE status: expected = b77b845 keys + S3 gyro_health, gyro_sat_count right after gyro_ok')
    return dict(golden, status=keys[:i] + S3_GYRO_STATUS_KEYS + keys[i:])

def main():
    if sys.argv[1] == '--capture':
        exe, board = sys.argv[2], sys.argv[3]
        print(json.dumps({board: capture(exe)}, indent=1))
        return
    exe, board = sys.argv[1], sys.argv[2]
    golden = json.load(open(GOLDEN))[board]
    got = capture(exe)
    golden = s3_expected_status(golden)
    notes = []
    for r in REPORTS:
        if golden[r] is None:
            notes.append(f'{r}: absent in golden, skipped')
            continue
        assert got[r] == golden[r], f'{board} {r}: keys/order changed vs b77b845\n golden {golden[r]}\n got    {got[r]}'
    print(f'PASS report keys ({board}): status/filters/loop_rate/receiver keys and order == b77b845, rpm_filter == #60 04769f9'
          + (' (' + '; '.join(notes) + ')' if notes else ''))

if __name__ == '__main__':
    main()
