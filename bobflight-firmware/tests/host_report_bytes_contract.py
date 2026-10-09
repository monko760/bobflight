# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
"""Report byte contract (safety S1, PR #61 review): the real host firmware's
`status` and `filters` replies must equal the b77b845 capture for the same
board BYTE FOR BYTE (CRLF included), so a value-format change (e.g. %.2f ->
%.3f, "ACTIVE" -> "active") fails even when keys and order are unchanged
(report_keys_contract only checks keys/order).
Allowed differences, nothing else:
  * filters: only the filters_sample_hz value, and only kakute_f7_hdv, and
    only 4000 (b77b845) -> 8000 (S1: the gyro filter runs on every gyro
    sample at 8000/2). dummy / tmotor_f7_v2 filters must be identical.
  * status: the three run-time counters `cascade=<n>`, `bg=<n>` (loop line)
    and `loop_overruns: <n>` depend on host wall-clock timing; they must
    still be plain decimal integers in the same place, the text around them
    is compared byte for byte.
  * status (S3, fix/gyro-sanity, frozen spec): exactly the two lines
    `gyro_health: ok\r\n` and `gyro_sat_count: 0\r\n` inserted right after
    the golden's `gyro_ok: ...\r\n` line. These are the exact bytes every
    host build prints (no gyro on the host: nothing to check, no samples, so
    health ok and count 0); any other value or position fails. The golden is
    not re-captured; the b77b845 bytes stay the reference for every other line.
Golden: tests/golden/report_bytes_b77b845.json, captured from b77b845 host
builds with:  python3 host_report_bytes_contract.py --capture <bobflight_host> <board>
Usage (ctest):  python3 host_report_bytes_contract.py <bobflight_host> <board>"""
import json, os, re, subprocess, sys

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'golden', 'report_bytes_b77b845.json')
SEP = 'zz_report_sep'
UNKNOWN = 'unknown \u2014 try help\r\n'
COUNTERS = [(re.compile(r'(\r\nloop: gyro=\d+ Hz denom=\d+ cascade=)(\d+)( bg=)(\d+)(\r\n)'), (2, 4)),
            (re.compile(r'(\r\nloop_overruns: )(\d+)(\r\n)'), (2,))]

def capture(exe):
    out = subprocess.run([exe], input=f'status\n{SEP}\nfilters\n{SEP}\n'.encode(), stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=60, check=True).stdout.decode('utf-8')
    body = out[out.index(' ready\r\n') + len(' ready\r\n'):]
    status, rest = body.split(UNKNOWN, 1)
    filters = rest.split(UNKNOWN, 1)[0]
    assert status.startswith('board: ') and filters.startswith('filters_api: 1\r\n'), out[:600]
    return {'status': status, 'filters': filters}

def mask_counters(text):
    """Replace the timing counters by '#'; every counter must be all digits."""
    for rx, groups in COUNTERS:
        m = rx.search('\r\n' + text)
        assert m, f'counter line missing or reformatted: {rx.pattern}'
        def sub(mm):
            parts = list(mm.groups())
            for gi in groups:
                assert parts[gi - 1].isdigit(), parts[gi - 1]
                parts[gi - 1] = '#'
            return ''.join(parts)
        text = rx.sub(sub, '\r\n' + text, count=1)[2:]
    return text

S3_GYRO_STATUS_LINES = 'gyro_health: ok\r\ngyro_sat_count: 0\r\n'

def s3_expected_status(golden_status):
    m = re.search(r'(?:^|\r\n)gyro_ok: (?:yes|no)\r\n', golden_status)
    assert m and golden_status.count('gyro_ok: ') == 1, 'golden: one gyro_ok line'
    assert 'gyro_health: ' not in golden_status and 'gyro_sat_count: ' not in golden_status
    return golden_status[:m.end()] + S3_GYRO_STATUS_LINES + golden_status[m.end():]

def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return min(len(a), len(b))

def main():
    if sys.argv[1] == '--capture':
        print(json.dumps({sys.argv[3]: capture(sys.argv[2])}, indent=1))
        return
    exe, board = sys.argv[1], sys.argv[2]
    # New target inherits the exact sensor-only wire format; only its board ID differs.
    golden = json.load(open(GOLDEN))['tmotor_f7_v2' if board=='matek_f722_px' else board]
    if board=='matek_f722_px': golden={k:v.replace('tmotor_f7_v2','matek_f722_px') for k,v in golden.items()}
    got = capture(exe)
    gs, ls = mask_counters(s3_expected_status(golden['status'])), mask_counters(got['status'])
    if gs != ls:
        i = first_diff(gs, ls)
        raise AssertionError(f'{board} status differs from b77b845 at byte {i}:\n golden {gs[max(0,i-40):i+40]!r}\n got    {ls[max(0,i-40):i+40]!r}')
    gf, lf = golden['filters'], got['filters']
    note = 'filters identical'
    if board == 'kakute_f7_hdv':
        assert '\r\nfilters_sample_hz: 4000\r\n' in gf, 'golden: Kakute b77b845 filter rate 4000'
        assert '\r\nfilters_sample_hz: 8000\r\n' in lf, f'Kakute filters_sample_hz must be 8000 (gyro rate):\n{lf!r}'
        gf = gf.replace('\r\nfilters_sample_hz: 4000\r\n', '\r\nfilters_sample_hz: 8000\r\n', 1)
        note = 'filters identical except filters_sample_hz 4000 -> 8000'
    if gf != lf:
        i = first_diff(gf, lf)
        raise AssertionError(f'{board} filters differs from b77b845 at byte {i}:\n golden {gf[max(0,i-40):i+40]!r}\n got    {lf[max(0,i-40):i+40]!r}')
    print(f'PASS report bytes ({board}): status byte-identical to b77b845 + exactly the S3 gyro_health/gyro_sat_count lines after gyro_ok (timing counters digits-only); {note}')

if __name__ == '__main__':
    main()
