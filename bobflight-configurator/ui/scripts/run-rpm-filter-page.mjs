/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-rpm-filter-page.tsx with FiltersPage's useHost swapped for the #57 test stub, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-rpm-filter-page.bundle.mjs");
let swapped = 0;
await build({
  entryPoints: [path.join(here, "test-rpm-filter-page.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        if (!args.importer.endsWith(path.join("src", "pages", "FiltersPage.tsx"))) return undefined;
        swapped++;
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
if (swapped !== 1) throw new Error(`expected FiltersPage's useHost import to be swapped once, got ${swapped}`);
await import(pathToFileURL(outfile).href);
