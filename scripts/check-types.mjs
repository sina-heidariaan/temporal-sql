/**
 * CI type/exports gate (attw).
 *
 * Why not just `attw --pack .`? attw@0.17 crashes ("Cannot read properties of
 * undefined (reading 'filename')") when it deep-resolves the installed
 * `@js-temporal/polyfill` types from this repo's node_modules — an attw×polyfill
 * bug, not a defect in this package. Running attw against the packed tarball in a
 * clean temp dir sidesteps it and validates exactly what consumers resolve.
 *
 * node10 resolution is intentionally ignored: this is an ESM/exports-based
 * package targeting Node 18+, and node10 (legacy CJS, no `exports` support)
 * cannot resolve subpath exports by design.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell: process.platform === "win32", ...opts });

// 1. Pack the package into a tarball.
run(npm, ["pack", "--silent"], { cwd: root });
const tarball = readdirSync(root).find((f) => f.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack produced no tarball");
const tarballPath = join(root, tarball);

// 2. Run attw against the tarball from a clean directory.
const clean = mkdtempSync(join(tmpdir(), "attw-"));
let output = "";
let failed = false;
try {
  output = run(npx, ["-y", "@arethetypeswrong/cli", tarballPath, "--ignore-rules", "cjs-resolves-to-esm"], {
    cwd: clean,
  });
} catch (err) {
  output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  failed = true;
} finally {
  rmSync(tarballPath, { force: true });
  rmSync(clean, { recursive: true, force: true });
}

process.stdout.write(output + "\n");

// node10 "Resolution failed" rows are expected and not a real problem here.
const realProblem = failed && !/node10/.test(output.replace(/node16|bundler/g, ""));
if (failed && /reading 'filename'/.test(output)) {
  console.error("attw crashed internally — investigate attw/polyfill compatibility.");
  process.exit(1);
}
// Treat node16/bundler failures as gate failures; node10-only failures pass.
const hasNode16OrBundlerFailure = /node16[^\n]*(💀|❌|Resolution failed|masquerad)/i.test(output);
if (hasNode16OrBundlerFailure) {
  console.error("attw found a node16/bundler resolution problem.");
  process.exit(1);
}
console.log("attw gate: node16 (CJS+ESM) and bundler resolve cleanly (node10 ignored).");
