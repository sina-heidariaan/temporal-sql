import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * `@js-temporal/polyfill` declares its `exports["."]` as a fallback *array*
 * (`[{ import, require, default }, "./dist/index.cjs"]`). Node resolves this
 * fine, but Vite's resolver throws "Failed to resolve entry for package".
 * Alias it to its concrete ESM entry for tests only — this does not affect the
 * tsup build (which uses Node/rollup resolution and works). The alias also
 * covers `temporal-gregorian`'s transitive import of the polyfill.
 */
const polyfillEsm = fileURLToPath(
  new URL("./node_modules/@js-temporal/polyfill/dist/index.esm.js", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@js-temporal/polyfill": polyfillEsm,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
