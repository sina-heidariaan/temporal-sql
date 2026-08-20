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
 *   node scripts/check-consumers.mjs                    # default sets: min + latest
 *   node scripts/check-consumers.mjs --peers=min
 *   node scripts/check-consumers.mjs --peers=latest
 *   node scripts/check-consumers.mjs --peers=drizzle-beta  # opt-in: drizzle-orm 1.x line
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();

/**
 * `npm publish --dry-run` exports `npm_config_dry_run=true`, and every nested npm
 * call inherits it — so when this gate runs from `prepublishOnly`, `npm pack`
 * would write no tarball and the fixture `npm install`s would install nothing.
 * Scrub it once here; the flag is meaningless for this script's own npm calls.
 */
delete process.env.npm_config_dry_run;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";

/**
 * These pin the exact bounds declared in package.json's `peerDependencies`, so
 * those ranges stay claims we have actually run rather than guesses.
 *
 * `pg` floors at 8.0.0 — the first 8.x. It briefly floored at 8.15.0, but that
 * was compensating for our own `import { types } from "pg"`: a named import from
 * a CJS package only resolves once Node's cjs-module-lexer can detect the export,
 * which it cannot before 8.15.0. `src/pg.ts` uses a default import instead, which
 * reads `module.exports` and works across all of 8.x — so the floor is a real
 * compatibility bound again rather than a workaround.
 */
const PEER_SETS = {
  min: {
    peers: { pg: "8.0.0", "drizzle-orm": "0.30.0" },
    fixtures: ["esm", "commonjs", "types"],
    default: true,
  },
  latest: {
    peers: { pg: "latest", "drizzle-orm": "latest" },
    // drizzle-zod reproduces drizzle-orm#5692 and pins the documented override
    // pattern; it needs a modern drizzle, so it runs in this set only.
    fixtures: ["esm", "commonjs", "types", "drizzle-zod"],
    default: true,
  },
  // The Drizzle 1.x (codec-layer) line. Opt-in (`--peers=drizzle-beta`): it
  // tracks upstream's moving `beta` dist-tag, so it must never block a release
  // of ours — CI runs it as a separate non-required job.
  //
  // installFlags: a 1.0.0-beta.* prerelease does not satisfy the declared peer
  // range `>=0.30.0` (semver prerelease rules), so npm needs --legacy-peer-deps
  // here. The manifest range stays honest on purpose: it will only widen to the
  // 1.x line once 1.0 is stable and this set is green against it.
  "drizzle-beta": {
    peers: { pg: "latest", "drizzle-orm": "beta" },
    fixtures: ["esm", "commonjs", "types", "drizzle-beta"],
    default: false,
    installFlags: ["--legacy-peer-deps"],
  },
};

/** Fixture-specific dev dependencies, installed alongside the tarball + peers. */
const EXTRA_DEPS = {
  types: ["typescript@latest"],
  "drizzle-zod": ["drizzle-zod@latest", "zod@latest"],
};

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", shell });

const arg = process.argv.find((a) => a.startsWith("--peers="));
const requested = arg ? arg.slice("--peers=".length) : null;
if (requested && !PEER_SETS[requested]) {
  console.error(`Unknown peer set "${requested}". Expected: ${Object.keys(PEER_SETS).join(", ")}`);
  process.exit(1);
}
const peerSets = requested
  ? [requested]
  : Object.keys(PEER_SETS).filter((name) => PEER_SETS[name].default);

// 1. Pack once, into a temp dir; every fixture installs this exact artifact.
// Packing outside the repo means we never scan the root for `*.tgz` — a stale
// tarball there used to be picked up, installed, and then deleted by this script.
console.log("Packing tarball…");
const packDir = mkdtempSync(join(tmpdir(), "consumer-pack-"));
const packJson = run(npm, ["pack", "--json", "--pack-destination", packDir], root);
const tarball = JSON.parse(packJson)[0]?.filename;
if (!tarball) throw new Error("npm pack produced no tarball");
const tarballPath = join(packDir, tarball);

const failures = [];
try {
  for (const setName of peerSets) {
    const { peers, fixtures, installFlags = [] } = PEER_SETS[setName];
    const peerSpecs = Object.entries(peers).map(([name, version]) => `${name}@${version}`);

    for (const fixture of fixtures) {
      const label = `${fixture} (peers: ${setName})`;
      // A fresh temp dir per run: no repo node_modules on the resolution path,
      // so a missing dependency or a broken exports entry fails here loudly
      // instead of being satisfied by the workspace.
      const dir = mkdtempSync(join(tmpdir(), `consumer-${fixture}-`));
      try {
        cpSync(join(root, "consumer-tests", fixture), dir, { recursive: true });
        const deps = [tarballPath, ...peerSpecs, ...(EXTRA_DEPS[fixture] ?? [])];
        run(npm, ["install", "--silent", "--no-audit", "--no-fund", ...installFlags, ...deps], dir);
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
  rmSync(packDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nConsumer gate failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nConsumer gate: packed tarball resolves and runs for ESM, CJS, and types.");
