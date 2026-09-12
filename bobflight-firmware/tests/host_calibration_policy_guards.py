# Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
import pathlib, subprocess, sys, tempfile
cc, cmake, source=sys.argv[1:]
with tempfile.TemporaryDirectory() as tmp:
    p=pathlib.Path(tmp)/"policy.c"
    p.write_text('#include "drivers/calibration_policy.h"\nint main(void){return 0;}\n')
    base=[cc,"-std=c11","-fsyntax-only","-I",source+"/src",str(p)]
    for flags in [[],["-DBOBFLIGHT_ACCEL_BENCH_RELAXED=0"],["-DBOBFLIGHT_ACCEL_BENCH_RELAXED=1"]]:
        subprocess.run(base+flags,check=True,capture_output=True,text=True)
    bad=subprocess.run(base+["-DBOBFLIGHT_ACCEL_BENCH_RELAXED=1","-DBOBFLIGHT_FLIGHT_ENABLE=1"],capture_output=True,text=True)
    assert bad.returncode and "bench-only" in bad.stderr,bad.stderr
    bad=subprocess.run(base+["-DBOBFLIGHT_ACCEL_BENCH_RELAXED=2"],capture_output=True,text=True)
    assert bad.returncode and "must be 0 or 1" in bad.stderr,bad.stderr
    bad=subprocess.run([cmake,"-S",source,"-B",tmp+"/forbidden","-DBOBFLIGHT_ACCEL_BENCH_RELAXED=ON","-DBOBFLIGHT_FLIGHT_ENABLE=ON"],capture_output=True,text=True)
    assert bad.returncode and "bench-only" in bad.stderr,bad.stderr
print("PASS default/strict/relaxed policy flags; preprocessor and CMake forbid relaxed+flight")
