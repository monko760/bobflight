/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-storage-panel-gated.tsx with every src `hooks/useHost` import swapped for the test stub, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-storage-panel-gated.bundle.mjs");
let swapped = 0;
await build({
  entryPoints: [path.join(here, "test-storage-panel-gated.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  define: { "import.meta.env": "{}" },
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)useHost$/ }, (args) => {
        if (!args.importer.includes(`${path.sep}src${path.sep}`)) return undefined;
        swapped++;
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
if (swapped < 4) throw new Error(`expected the StoragePanel and page useHost imports to be swapped, got ${swapped}`);
await import(pathToFileURL(outfile).href);
