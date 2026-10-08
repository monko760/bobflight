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
