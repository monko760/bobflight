/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-flasher-safety.tsx with FlasherPage's useHost swapped for the test stub, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-flasher-safety.bundle.mjs");
let swapped = 0;

await build({
  entryPoints: [path.join(here, "test-flasher-safety.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile,
  jsx: "automatic",
  logLevel: "warning",
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /^\.\.\/flasher$/ }, args => {
        if (!args.importer.endsWith(path.join('src','pages','FlasherPage.tsx'))) return undefined;
        return { path: path.join(here,'fixtures','flasherBackendStub.ts') };
      });
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        if (!args.importer.endsWith(path.join("src", "pages", "FlasherPage.tsx"))) return undefined;
        swapped++;
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});

if (swapped !== 1) throw new Error(`expected FlasherPage's useHost import to be swapped once, got ${swapped}`);
await import(pathToFileURL(outfile).href);
