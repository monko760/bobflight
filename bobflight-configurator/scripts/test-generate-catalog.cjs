// Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
// The catalog generator rejects malformed registry output (its shape check is load-bearing).
const assert=require('node:assert/strict');
const {validateRegistry,readRegistry}=require('./generate-target-catalog.cjs');
const good=readRegistry();
assert.equal(validateRegistry(structuredClone(good)).boards.length,good.boards.length);
const bad=[
 d=>{d.schema_version=2;},
 d=>{delete d.schema_version;},
 d=>{d.boards={};},
 d=>{delete d.mcus;},
 d=>{d.diagnostic_profiles=null;},
 d=>{d.boards[0].id='Bad Id';},
 d=>{d.boards[0].mcu='stm32h999';},
 d=>{delete d.diagnostic_profiles[0].display_name;},
 d=>{d.boards.push(null);},
];
bad.forEach((mutate,i)=>{
 const d=structuredClone(good);mutate(d);
 assert.throws(()=>validateRegistry(d),/Invalid registry output/,'case '+i);
});
console.log(`generator shape check: ${bad.length} malformed registries rejected`);
