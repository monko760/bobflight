// SPDX-License-Identifier: Apache-2.0
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));let swaps=0;
const outfile=path.join(here,'test-post-flash.bundle.mjs');
await build({entryPoints:[path.join(here,'test-post-flash.tsx')],bundle:true,platform:'node',format:'esm',packages:'external',outfile,jsx:'automatic',plugins:[{name:'injected-host',setup(b){b.onResolve({filter:/^\.\.\/protocol$/},args=>{if(!args.importer.endsWith(path.join('hooks','useHost.tsx')))return;swaps++;return {path:path.join(here,'fixtures','injectedHostFixture.ts')};});}}]});
if(swaps!==1)throw Error('Provider fixture injection failed');
await import(pathToFileURL(outfile).href);
