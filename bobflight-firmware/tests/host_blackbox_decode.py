#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
"""Clean-room schema 4 decoder test, written from BobFlight's own format
(src/flight/blackbox_encode.c, docs/BLACKBOX-FIELDS.md), no third-party code.

Runs bobflight_blackbox_encode_test to write its 600-frame fixture, then parses
the header field definitions and every I frame generically and checks the
schema 4 fields, the header keys and the bit layouts round-trip."""
import subprocess
import sys
import tempfile
from pathlib import Path


def varint(buf, pos):
    value = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7
        if shift > 28:
            raise ValueError("varint longer than 5 bytes")


def decode(data):
    headers, pos = {}, 0
    while data.startswith(b"H ", pos):
        end = data.index(b"\n", pos)
        key, _, value = data[pos + 2:end].decode("ascii").partition(":")
        headers[key] = value
        pos = end + 1
    assert max(len(line) for line in data[:pos].splitlines()) <= 1023, "Explorer header-line bound"
    names = headers["Field I name"].split(",")
    signed = [int(v) for v in headers["Field I signed"].split(",")]
    encoding = [int(v) for v in headers["Field I encoding"].split(",")]
    assert len(names) == len(signed) == len(encoding), "field definition lengths differ"
    frames, end_seen = [], False
    while pos < len(data):
        tag = data[pos]
        pos += 1
        if tag == ord("I"):
            frame = {}
            for name, sgn, enc in zip(names, signed, encoding):
                raw, pos = varint(data, pos)
                if enc == 1:  # unsigned varint
                    assert sgn == 0, name
                    frame[name] = raw
                else:  # zigzag signed varint
                    assert enc == 0 and sgn == 1, name
                    frame[name] = (raw >> 1) ^ -(raw & 1)
            frames.append(frame)
        elif tag == ord("P"):
            assert frames, "P without an absolute anchor"
            assert headers["Field P predictor"].split(",") == ["1"] * len(names)
            assert headers["Field P encoding"].split(",") == ["0"] * len(names)
            frame = {}
            for name in names:
                raw, pos = varint(data, pos)
                frame[name] = frames[-1][name] + ((raw >> 1) ^ -(raw & 1))
            frames.append(frame)
        elif tag == ord("E"):
            assert data[pos:pos + 12] == b"\xffEnd of log\x00", "bad end marker"
            pos += 12
            end_seen = True
            assert pos == len(data), "bytes after the end marker"
        else:
            raise AssertionError(f"unexpected frame tag {tag:#x} at {pos - 1}")
    assert end_seen, "no end marker"
    return headers, names, frames


def main():
    exe = sys.argv[1]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "fixture.bbl"
        subprocess.run([exe, str(path)], check=True, stdout=subprocess.DEVNULL)
        data = path.read_bytes()
        delta_path = Path(tmp) / "delta.bbl"
        subprocess.run([exe, str(delta_path), "delta"], check=True, stdout=subprocess.DEVNULL)
        dh, dn, df = decode(delta_path.read_bytes())
        ih, ino, iff = decode(data)
        assert dn == ino and df == iff, "delta stream must preserve every field exactly"
        assert len(delta_path.read_bytes()) < len(data), "delta fixture should shrink"
    headers, names, frames = decode(data)
    assert len(names) == 71, len(names)
    assert "bfIteration" not in names
    assert names[-9:] == ["eRPM[0]", "eRPM[1]", "eRPM[2]", "eRPM[3]", "bfTelemOk",
                          "bfFilterFlags", "bfEvents", "bfLoopCode",
                          "bfOverruns"], names[-9:]
    assert headers["BobFlight log_schema"] == "4"
    assert headers["BobFlight board"] == "kakute_f7_hdv"
    assert headers["BobFlight fw_version"] == "0.2.0-encoder-fixture"
    assert headers["Firmware revision"] == "BobFlight 0.2.0-encoder-fixture"
    assert headers["BobFlight loop_rate_hz"] == "1000 gyro_hz:8000 pid_denom:8"
    for key in ("gyro_lpf_hz", "gyro_notch1_hz", "gyro_notch1_cutoff_hz", "gyro_notch2_hz",
                "gyro_notch2_cutoff_hz", "rpm_filter_harmonics", "rpm_filter_min_hz",
                "rpm_filter_q_x100", "motor_poles"):
        float(headers["BobFlight " + key])
    # Standard key (stock Explorer RPM scaling) equals the BobFlight value (BB1 QA F1).
    assert headers["motor_poles"] == "14", headers.get("motor_poles")
    assert int(headers["motor_poles"]) == float(headers["BobFlight motor_poles"])
    assert len(frames) == 600, len(frames)
    for j, f in enumerate(frames):
        assert f["loopIteration"] == j * 2 and f["time"] == 10000 + j * 2000, j
        assert f["bfSchema"] == 4, j
        for m in range(4):
            assert f[f"eRPM[{m}]"] == (j * 1000 + m * 37 + 57) // 100, (j, m)
        assert f["bfTelemOk"] == j % 16
        assert f["bfFilterFlags"] == j % 128
        assert f["bfEvents"] == (j * 7) % 128
        assert f["bfLoopCode"] == j % 33
        assert f["bfOverruns"] == j * 3
        # Documented bit layout of the filter flags decodes consistently.
        flags = f["bfFilterFlags"]
        fields = (flags & 1, flags >> 1 & 1, flags >> 2 & 1, flags >> 3 & 3, flags >> 5 & 3)
        assert flags == fields[0] | fields[1] << 1 | fields[2] << 2 | fields[3] << 3 | fields[4] << 5
        assert f["gyroADC[0]"] == 250 and f["motor[0]"] == 447 and f["bfPidValid"] == 0
    sizes = len(data) - data.index(b"\nI") - 1 - 13
    print(f"PASS clean-room schema 4 decoder: 71 fields, schema 4 header (board, fw_version, loop, filters), "
          f"600 frames, eRPM/100 and flag/event/loop/overrun fields round-trip; {sizes / 600:.1f} B/frame")


if __name__ == "__main__":
    main()
