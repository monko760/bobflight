/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/** Bundles test-motor-direction.tsx with the useHost of MotorsPage and StoragePanel swapped for the #57 test stub, then runs it. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-motor-direction.bundle.mjs");
const STUBBED = [path.join("src", "pages", "MotorsPage.tsx"), path.join("src", "components", "StoragePanel.tsx")];
const swapped = new Set();
await build({
  entryPoints: [path.join(here, "test-motor-direction.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        const who = STUBBED.find((f) => args.importer.endsWith(f));
        if (!who) return undefined;
        swapped.add(who);
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
if (swapped.size !== STUBBED.length) throw new Error(`expected useHost swapped for ${STUBBED.join(", ")}; got ${[...swapped].join(", ")}`);
await import(pathToFileURL(outfile).href);
