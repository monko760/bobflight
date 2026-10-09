import {build} from 'esbuild';import {fileURLToPath,pathToFileURL} from 'node:url';import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));const outfile=path.join(here,'test-calibration-page.bundle.mjs');
await build({entryPoints:[path.join(here,'test-calibration-page.tsx')],bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile,plugins:[{name:'calibration-state-stubs',setup(b){b.onResolve({filter:/\/(useSensorTelemetry|StoragePanel)$/},args=>args.importer.endsWith('SensorsPage.tsx')?{path:path.join(here,'fixtures/calibrationUiStub.tsx')}:undefined);}}]});
await import(pathToFileURL(outfile).href);
