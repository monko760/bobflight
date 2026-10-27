/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * D1: firmware `storage` gained an additive `accel_cal_saved: yes|no` line just
 * before `storage_end: 1`. The shipped parser (real parseStorage / canSaveStorage
 * from dist, no source inspection) must read the same snapshot with or without it.
 */
const assert=require('node:assert/strict'),p=require('../dist');
const base=(eol,extra='')=>['storage_api: 1','backend: flash','schema: 13','state: dirty','dirty: 1','generation: 5','last_error: none',
 `scope: ${p.STORAGE_SCOPE_V13}`,'armed: 0','bench_active: 0','calibration_active: 0','flight_enabled: 1',...(extra?[extra]:[]),'storage_end: 1'].join(eol)+eol;
for(const eol of ['\r\n','\n']){
 const old=p.parseStorage(base(eol));
 for(const v of ['yes','no']){
  const next=p.parseStorage(base(eol,`accel_cal_saved: ${v}`));
  assert.deepEqual(next,old,`accel_cal_saved: ${v} must not change the parsed snapshot`);
  assert.equal(p.canSaveStorage(next,true,false),p.canSaveStorage(old,true,false));
 }
}
/* A duplicated line is still a malformed snapshot (the parser's existing rule). */
assert.throws(()=>p.parseStorage(base('\r\n','accel_cal_saved: yes\r\naccel_cal_saved: no')),/Duplicate/);
console.log('PASS current storage parser ignores the additive accel_cal_saved line (yes/no, CRLF/LF); snapshot and canSaveStorage unchanged');
