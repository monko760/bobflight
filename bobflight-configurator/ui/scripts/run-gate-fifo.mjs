/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-gate-fifo.tsx with every src/ useHost import swapped for the test stub (the test owns the
 * context value: the real ProtocolHostAdapter over a simulated FC), then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-gate-fifo.bundle.mjs");
const src = path.join(path.dirname(here), "src") + path.sep;
const swapped = new Set();
await build({
  entryPoints: [path.join(here, "test-gate-fifo.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  define: { "import.meta.env": "{}" },
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$|^\.\/useHost$/ }, (args) => {
        if (!args.importer.startsWith(src)) return undefined;
        swapped.add(path.relative(src, args.importer));
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
for (const f of [path.join("pages", "MotorsPage.tsx"), path.join("components", "StoragePanel.tsx")])
  if (![...swapped].includes(f)) throw new Error(`expected useHost swapped for ${f}; got ${[...swapped].join(", ")}`);
await import(pathToFileURL(outfile).href);
