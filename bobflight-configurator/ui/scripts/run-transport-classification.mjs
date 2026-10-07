/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "test-transport-classification.bundle.mjs");

await build({
  entryPoints: [path.join(here, "test-transport-classification.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile,
  logLevel: "warning",
  define: {
    "import.meta.env": "{}",
  },
});

await import(pathToFileURL(outfile).href);
