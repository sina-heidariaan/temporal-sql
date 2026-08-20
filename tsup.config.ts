import { defineConfig } from "tsup";

// One entry per public subpath so a driver import (`temporal-sql/pg`) never drags
// in another driver's peer dependency. The pure codec modules are pulled in via
// `index.ts`; the driver entries import only their own peer.
export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/pg.ts",
      "src/postgres-js.ts",
      "src/drizzle.ts",
      "src/prisma.ts",
      "src/session.ts",
      "src/doctor.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    treeshake: true,
    sourcemap: true,
    target: "es2022",
  },
  // The CLI: ESM-only, with a shebang, no type declarations. Built second with
  // clean:false so it doesn't wipe the main build.
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    dts: false,
    clean: false,
    treeshake: true,
    sourcemap: true,
    target: "es2022",
  },
]);
