/**
 * CI type/exports gate (attw).
 *
 * Why not just `attw --pack .`? Running attw against the packed tarball in a
 * clean temp dir validates exactly what consumers resolve, independent of this
 * repo's own node_modules. (Historically this also sidestepped an attw crash on
 * packages wrapping `@js-temporal/polyfill`, caused by a transitive `fflate@0.8.3`
 * tarball-extraction bug — fixed in attw 0.18.3, which this package now requires.)
 *
 * node10 resolution is intentionally ignored: this is an ESM/exports-based
 * package targeting Node 18+, and node10 (legacy CJS, no `exports` support)
 * cannot resolve subpath exports by design.
 *
 * This gate is Node-version-independent by nature — it statically inspects the
 * tarball's `exports` map — so CI runs it once rather than across the matrix.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Pinned deliberately. `npx -y <pkg>` resolves the *latest* release, so without
 * a pin this gate silently tracks whatever attw ships today and the
 * devDependency range is decorative. Keep in sync with package.json.
 */
const ATTW_VERSION = "0.18.5";

/**
 * attw itself requires Node >=20 (0.17.4 was the last release supporting 18).
 * This package supports Node 18, so a contributor on 18 can legitimately run
 * `npm run check` — skip with an explanation rather than crashing in attw's
 * internals with an unrelated-looking "reading 'filename'" TypeError.
 */
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.log(
    `attw gate: skipped — @arethetypeswrong/cli@${ATTW_VERSION} requires Node >=20 ` +
      `(this is ${process.version}). The gate is Node-independent; CI runs it on Node 22.`,
  );
  process.exit(0);
}

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
  output = run(npx, ["-y", `@arethetypeswrong/cli@${ATTW_VERSION}`, tarballPath, "--ignore-rules", "cjs-resolves-to-esm"], {
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

// Treat node16/bundler failures as gate failures; node10-only failures pass.
const hasNode16OrBundlerFailure = /node16[^\n]*(💀|❌|Resolution failed|masquerad)/i.test(output);
if (hasNode16OrBundlerFailure) {
  console.error("attw found a node16/bundler resolution problem.");
  process.exit(1);
}
// Any other non-node10 attw failure (e.g. a genuine crash) fails the gate.
if (failed && !/node10/.test(output.replace(/node16|bundler/g, ""))) {
  console.error("attw exited non-zero:\n" + output);
  process.exit(1);
}
console.log("attw gate: node16 (CJS+ESM) and bundler resolve cleanly (node10 ignored).");
