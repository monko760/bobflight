/* SPDX-License-Identifier: Apache-2.0 */
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const ts=require('typescript');

// Resolve imports relative to the source being tested, not this test's folder.
// Real local components are loaded recursively; only explicit test seams are injected.
function loadUiTs(entry,overrides={}){
 const cache=new Map();
 function load(file){
  file=path.resolve(file);
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const scopedRequire=createRequire(file);
  const customRequire=id=>{
   if(Object.hasOwn(overrides,id))return overrides[id];
   if(id.startsWith('.')){
    const base=path.resolve(path.dirname(file),id);
    for(const candidate of [base+'.ts',base+'.tsx',path.join(base,'index.ts'),path.join(base,'index.tsx')]){
     if(fs.existsSync(candidate))return load(candidate);
    }
   }
   return scopedRequire(id); // Missing imports still fail the test.
  };
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{
   fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',
   {console,setTimeout,clearTimeout,URL,Blob},{filename:file})(customRequire,module,module.exports);
  return module.exports;
 }
 return load(entry);
}
module.exports={loadUiTs};
