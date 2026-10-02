/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-receiver-link.tsx with ReceiverPage's and StoragePanel's useHost swapped for the test stub, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-receiver-link.bundle.mjs");
const owners = [path.join("src", "pages", "ReceiverPage.tsx"), path.join("src", "components", "StoragePanel.tsx")];
let swapped = 0;
await build({
  entryPoints: [path.join(here, "test-receiver-link.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        if (!owners.some((o) => args.importer.endsWith(o))) return undefined;
        swapped++;
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
if (swapped !== 2) throw new Error(`expected ReceiverPage's and StoragePanel's useHost imports to be swapped (2), got ${swapped}`);
await import(pathToFileURL(outfile).href);
