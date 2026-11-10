/* SPDX-License-Identifier: Apache-2.0 */
/** Bundles the PID/Filters honesty render test with useHost swapped for the test stub. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-pid-filters-honesty.bundle.mjs");
const pages = ["PidPage.tsx", "FiltersPage.tsx"].map((p) => path.join("src", "pages", p));
const swapped = new Map(pages.map((p) => [p, 0]));
await build({
  entryPoints: [path.join(here, "test-pid-filters-honesty.tsx")],
  bundle: true, platform: "node", format: "esm", packages: "external", outfile, jsx: "automatic", logLevel: "warning",
  define: { "import.meta.env": "{}" },
  plugins: [{
    name: "use-host-stub",
    setup(b) {
      b.onResolve({ filter: /(^|\/)hooks\/useHost$/ }, (args) => {
        const page = pages.find((p) => args.importer.endsWith(p));
        if (!page) return undefined;
        swapped.set(page, swapped.get(page) + 1);
        return { path: path.join(here, "fixtures", "useHostStub.ts") };
      });
    },
  }],
});
for (const [p, n] of swapped) if (n !== 1) throw new Error(`expected ${p}'s useHost import to be swapped once, got ${n}`);
await import(pathToFileURL(outfile).href);
