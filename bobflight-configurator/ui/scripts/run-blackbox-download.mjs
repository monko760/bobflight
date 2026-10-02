/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-blackbox-download.tsx with BlackboxPage's useHost and saveBlob swapped for test stubs, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-blackbox-download.bundle.mjs");
const swapped = { useHost: 0, saveBlob: 0 };
const page = path.join("src", "pages", "BlackboxPage.tsx");
await build({
  entryPoints: [path.join(here, "test-blackbox-download.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  plugins: [{
    name: "blackbox-page-stubs",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        if (!args.importer.endsWith(page)) return undefined;
        swapped.useHost++;
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
      b.onResolve({ filter: /(^|\/)blackbox\/saveBlob$/ }, (args) => {
        if (!args.importer.endsWith(page)) return undefined;
        swapped.saveBlob++;
        return { path: path.join(here, "fixtures", "saveBlobStub.ts") };
      });
    },
  }],
});
if (swapped.useHost !== 1 || swapped.saveBlob !== 1) throw new Error(`expected BlackboxPage's useHost and saveBlob imports to be swapped once each, got ${JSON.stringify(swapped)}`);
await import(pathToFileURL(outfile).href);
