/* SPDX-License-Identifier: Apache-2.0 */
const esbuild=require('esbuild'),assert=require('node:assert/strict');
const out=esbuild.buildSync({entryPoints:['src/protocol/types.ts'],bundle:true,platform:'node',format:'cjs',write:false});const m={exports:{}};new Function('module','exports',out.outputFiles[0].text)(m,m.exports);
for(const cmd of ['sd probe','sd status','sd cancel'])assert.equal(m.exports.parseCliInput(cmd),cmd);
for(const cmd of ['sd format','sd write 0','sd status\narm','sd probe extra'])assert.equal(m.exports.parseCliInput(cmd),null);
console.log('PASS UI SD diagnostic allowlist and injection rejection');
