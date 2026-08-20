/**
 * `temporal-sql` CLI. One command today:
 *
 *   temporal-sql doctor [--url <connection-string>] [--json | --markdown]
 *
 * Connects with whichever supported driver is installed (`pg`, then
 * `postgres`), runs {@link runDoctor}, prints the report, and exits 0 when
 * every check passed / 1 otherwise — so it slots into CI as a gate.
 *
 * The connection string comes from `--url` or the `DATABASE_URL` environment
 * variable. No dependencies beyond the optional driver peers.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { runDoctor, renderDoctorText, renderDoctorMarkdown } from "./doctor.js";
import type { SessionQuery } from "./session.js";

const HELP = `temporal-sql — Postgres ⇄ TC39 Temporal codecs

Usage:
  temporal-sql doctor [--url <connection-string>] [--json | --markdown]

Checks that this environment decodes/encodes Temporal values correctly:
session settings, timezone independence, microsecond precision, per-type
round-trips, all four IntervalStyles, and driver/ORM compatibility.

Options:
  --url <conn>   Postgres connection string (default: $DATABASE_URL)
  --json         Print the full report as JSON
  --markdown     Print the report as Markdown (e.g. for a CI job summary)
  --help         Show this help

Exit code: 0 when every check passes, 1 otherwise.`;

/**
 * Resolve an installed package's version without importing it: walk up from
 * its entry file to the nearest package.json with the right name. Works for
 * packages whose exports map hides `./package.json` (postgres.js does).
 */
function packageVersion(require: NodeRequire, name: string): string | null {
  let file: string;
  try {
    file = require.resolve(name);
  } catch {
    return null;
  }
  let dir = dirname(file);
  for (let depth = 0; depth < 10; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "installed (version unknown)";
}

interface Connection {
  driver: string;
  query: SessionQuery;
  close: () => Promise<void>;
}

/** Connect with the first installed supported driver. */
async function connect(url: string): Promise<Connection> {
  try {
    const { default: pg } = (await import("pg")) as typeof import("pg") & { default: typeof import("pg") };
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return {
      driver: "pg",
      query: (sql) => client.query(sql),
      close: () => client.end(),
    };
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find (module|package)/.test(String(e))) {
      throw e; // pg is installed but the connection failed — report that, don't mask it
    }
  }
  try {
    const { default: postgres } = (await import("postgres")) as { default: typeof import("postgres") };
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    return {
      driver: "postgres",
      query: (text) => sql.unsafe(text),
      close: () => sql.end(),
    };
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find (module|package)/.test(String(e))) {
      throw e;
    }
  }
  throw new Error(
    'No supported driver found. Install "pg" or "postgres" next to temporal-sql, e.g.: npm install pg',
  );
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP);
    return args.length === 0 ? 1 : 0;
  }
  const command = args[0];
  if (command !== "doctor") {
    console.error(`Unknown command "${command}". Only "doctor" is available.\n\n${HELP}`);
    return 1;
  }

  let url = process.env.DATABASE_URL;
  let format: "text" | "json" | "markdown" = "text";
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--url") {
      url = args[++i];
      if (!url) {
        console.error("--url needs a value.");
        return 1;
      }
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (arg === "--json") {
      format = "json";
    } else if (arg === "--markdown" || arg === "--md") {
      format = "markdown";
    } else {
      console.error(`Unknown option "${arg}".\n\n${HELP}`);
      return 1;
    }
  }
  if (!url) {
    console.error("No connection string. Pass --url <conn> or set DATABASE_URL.");
    return 1;
  }

  const require = createRequire(import.meta.url);
  const packages: Record<string, string | null> = {};
  for (const name of ["pg", "postgres", "drizzle-orm", "@prisma/client"]) {
    packages[name] = packageVersion(require, name);
  }

  let connection: Connection;
  try {
    connection = await connect(url);
  } catch (e) {
    console.error(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    const report = await runDoctor(connection.query, { packages });
    if (format === "json") console.log(JSON.stringify(report, null, 2));
    else if (format === "markdown") console.log(renderDoctorMarkdown(report));
    else console.log(renderDoctorText(report));
    return report.ok ? 0 : 1;
  } finally {
    await connection.close();
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
