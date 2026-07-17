/**
 * Packed-consumer gate.
 *
 * `npm test` exercises `src/`; it proves nothing about what consumers actually
 * resolve. This packs the tarball and installs it into clean throwaway projects
 * — one per module system, plus a type-only project — so the `exports` map, the
 * dual ESM/CJS build, and the emitted `.d.ts`/`.d.cts` are all exercised the way
 * a real dependant would exercise them.
 *
 * Peer versions are tested at both ends of the declared `peerDependencies`
 * ranges, since "*" told consumers nothing and the narrowed ranges are only
 * honest if both bounds are actually run.
 *
 * Usage:
 *   node scripts/check-consumers.mjs            # both peer sets
 *   node scripts/check-consumers.mjs --peers=min
 *   node scripts/check-consumers.mjs --peers=latest
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";

/**
 * These pin the exact bounds declared in package.json's `peerDependencies`, so
 * those ranges stay claims we have actually run rather than guesses.
 *
 * `pg` floors at 8.15.0: earlier releases are CJS-only in a way Node's named-export
 * detection cannot see through, so `import { types } from "pg"` — which
 * `temporal-sql/pg` does — throws "does not provide an export named 'types'" for
 * any ESM consumer. CJS consumers work further back, but peerDependencies cannot
 * express a per-module-system floor, so the ESM bound governs.
 */
const PEER_SETS = {
  min: { pg: "8.15.0", "drizzle-orm": "0.30.0" },
  latest: { pg: "latest", "drizzle-orm": "latest" },
};

/** Fixtures are plain directories under consumer-tests/, each with an npm `start`. */
const FIXTURES = ["esm", "commonjs", "types"];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", shell });

const arg = process.argv.find((a) => a.startsWith("--peers="));
const requested = arg ? arg.slice("--peers=".length) : null;
if (requested && !PEER_SETS[requested]) {
  console.error(`Unknown peer set "${requested}". Expected: ${Object.keys(PEER_SETS).join(", ")}`);
  process.exit(1);
}
const peerSets = requested ? [requested] : Object.keys(PEER_SETS);

// 1. Pack once; every fixture installs this exact artifact.
console.log("Packing tarball…");
run(npm, ["pack", "--silent"], root);
const tarball = readdirSync(root).find((f) => f.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack produced no tarball");
const tarballPath = join(root, tarball);

const failures = [];
try {
  for (const setName of peerSets) {
    const peers = PEER_SETS[setName];
    const peerSpecs = Object.entries(peers).map(([name, version]) => `${name}@${version}`);

    for (const fixture of FIXTURES) {
      const label = `${fixture} (peers: ${setName})`;
      // A fresh temp dir per run: no repo node_modules on the resolution path,
      // so a missing dependency or a broken exports entry fails here loudly
      // instead of being satisfied by the workspace.
      const dir = mkdtempSync(join(tmpdir(), `consumer-${fixture}-`));
      try {
        cpSync(join(root, "consumer-tests", fixture), dir, { recursive: true });
        const deps = [tarballPath, ...peerSpecs];
        if (fixture === "types") deps.push("typescript@latest");
        run(npm, ["install", "--silent", "--no-audit", "--no-fund", ...deps], dir);
        const out = run(npm, ["start", "--silent"], dir);
        console.log(`PASS  ${label}${out.trim() ? ` — ${out.trim()}` : ""}`);
      } catch (err) {
        const detail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message;
        console.error(`FAIL  ${label}\n${detail}\n`);
        failures.push(label);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
} finally {
  rmSync(tarballPath, { force: true });
}

if (failures.length) {
  console.error(`\nConsumer gate failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nConsumer gate: packed tarball resolves and runs for ESM, CJS, and types.");
