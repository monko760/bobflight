import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["buffer", "events", "process", "util", "stream"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      // Browser: compile protocol TS source as ESM (avoid CJS dist + serialport/events).
      "@bobflight/protocol": path.resolve(
        __dirname,
        "../protocol/src/index.ts",
      ),
      // serialport is Node-native — stub for browser mock / Web Serial builds.
      serialport: path.resolve(__dirname, "src/shims/serialport-stub.ts"),
    },
  },
  optimizeDeps: {
    include: ["buffer", "events"],
    // Protocol is aliased to TS source; serialport is stubbed — do not prebundle package entry.
    exclude: ["@bobflight/protocol", "serialport"],
  },
  define: {
    global: "globalThis",
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
  },
});
