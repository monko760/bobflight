const assert=require('node:assert/strict');
const {assertMcuGate}=require('../dist/flasher/mcu-gate.js');
const base=0x08000000,data=new Uint8Array(32);
const image={baseAddress:base,bytes:data,regions:[{address:base,data}]};
for(const mcu of ['F411','H743','STM32F722','unknown','']) {
 assert.throws(()=>assertMcuGate(image,{expectedMcu:mcu}),/Unsupported target/);
 assert.throws(()=>assertMcuGate({...image,mcu},{expectedMcu:'F722'}),/Unsupported firmware/);
}
assert.doesNotThrow(()=>assertMcuGate(image,{expectedMcu:'F722'}));
assert.throws(()=>assertMcuGate({...image,mcu:'F745'},{expectedMcu:'F722'}),/tagged/);
console.log('PASS explicit unsupported MCU refusal, supported untagged image and mismatch guards');

assert.throws(()=>assertMcuGate(image,{expectedMcu:'F405'}),/explicit profile/);

// Flash-size gate: RM0431 STM32F722 has 512 KiB, RM0385 STM32F745 1 MiB (from 0x08000000).
// Literal sizes on purpose so a wrong MCU_FLASH_SIZE entry fails here.
const sized=(n,addr=base)=>{const d=new Uint8Array(n);return {baseAddress:addr,bytes:d,regions:[{address:addr,data:d}]};};
assert.doesNotThrow(()=>assertMcuGate(sized(512*1024),{expectedMcu:'F722'}));
assert.throws(()=>assertMcuGate(sized(512*1024+4),{expectedMcu:'F722'}),/exceeds F722 flash/);
assert.throws(()=>assertMcuGate(sized(4,base+512*1024),{expectedMcu:'F722'}),/exceeds F722 flash/);
assert.doesNotThrow(()=>assertMcuGate(sized(1024*1024),{expectedMcu:'F745'}));
assert.throws(()=>assertMcuGate(sized(1024*1024+4),{expectedMcu:'F745'}),/exceeds F745 flash/);
console.log('PASS flash-size gate: F722 512 KiB and F745 1 MiB limits');
