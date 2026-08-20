/**
 * `temporal-sql doctor` — the diagnostic engine.
 *
 * Runs a battery of checks against a live Postgres connection and reports
 * whether this environment will decode/encode Temporal values correctly:
 *
 *   - session settings (`DateStyle`, `IntervalStyle`, `TimeZone`)
 *   - timezone independence (`timestamptz` decodes to the same `Instant`
 *     whatever the session `TimeZone` is)
 *   - microsecond precision through a real server round-trip
 *   - decode → encode → decode round-trips for every scalar type
 *   - all four `IntervalStyle` outputs
 *   - server version (ranges need 9.2+, multiranges 14+)
 *   - driver/ORM versions and their known caveats, when supplied
 *
 * Driver-agnostic: like `temporal-sql/session`, it takes a {@link SessionQuery}
 * lambda, so the same engine runs over `pg`, `postgres.js`, or Drizzle. The
 * `temporal-sql` CLI wires this to a connection string for you.
 *
 * The engine issues `SET IntervalStyle` / `SET TimeZone` while probing and puts
 * the original values back before returning. Run it on a dedicated connection
 * if concurrent queries share yours.
 */
import type { SessionQuery, SessionResult } from "./session.js";
import {
  decodeInstant,
  encodeInstant,
  decodePlainDate,
  encodePlainDate,
  decodePlainDateTime,
  encodePlainDateTime,
  decodePlainTime,
  encodePlainTime,
  decodeTimetz,
  encodeTimetz,
  decodeDuration,
  PrecisionError,
} from "./index.js";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";

/** Outcome of one check. `skip` means a prerequisite was missing, not a problem. */
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  /** Stable machine id, e.g. `"session-datestyle"`. */
  id: string;
  /** Human title, e.g. `"DateStyle is ISO"`. */
  title: string;
  status: DoctorStatus;
  /** One or two plain sentences: what was observed, and how to fix it on failure. */
  detail: string;
}

export interface DoctorEnvironment {
  /** `process.version`, when available. */
  node: string | null;
  /** Whether `Temporal` is the engine's own or the polyfill. */
  temporalRuntime: "native" | "polyfill";
  /** Versions of relevant installed packages (`pg`, `postgres`, `drizzle-orm`, …); `null` = not installed. */
  packages: Record<string, string | null>;
}

export interface DoctorReport {
  /** True when no check failed. Warnings do not clear this flag to false. */
  ok: boolean;
  environment: DoctorEnvironment;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /**
   * Installed package versions to report on (the CLI fills this in by resolving
   * `pg`, `postgres`, `drizzle-orm`, `@prisma/client`). `null` = not installed.
   */
  packages?: Record<string, string | null>;
}

/** Extract rows from either result shape (`pg`'s `{ rows }` or a bare array). */
function rowsOf(result: SessionResult): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows;
  if (Array.isArray(rows)) return rows;
  throw new Error("Query returned an unrecognized shape (expected a row array or { rows: [...] }).");
}

/** Run one SQL string and return the first column of the first row as text. */
async function scalar(query: SessionQuery, sql: string): Promise<string> {
  const rows = rowsOf(await query(sql));
  const first = rows[0];
  if (!first) throw new Error(`${sql} returned no rows.`);
  return String(Object.values(first)[0]);
}

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The interval literal probed under every IntervalStyle, and its Duration. */
const INTERVAL_PROBE = "1 year 2 mons 3 days 04:05:06.789012";
const INTERVAL_EXPECTED = "P1Y2M3DT4H5M6.789012S";

/** SET values are allowlisted/validated — `SET <guc>` cannot be parameterized. */
const TZ_SAFE = /^[A-Za-z0-9_+\-/:.]+$/;

export async function runDoctor(query: SessionQuery, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, title: string, status: DoctorStatus, detail: string): void => {
    checks.push({ id, title, status, detail });
  };

  const environment: DoctorEnvironment = {
    node: typeof process !== "undefined" ? process.version : null,
    temporalRuntime: (globalThis as { Temporal?: unknown }).Temporal ? "native" : "polyfill",
    packages: opts.packages ?? {},
  };

  // ---- connectivity + session settings -----------------------------------
  let dateStyle: string | null = null;
  let intervalStyle: string | null = null;
  let timeZone: string | null = null;
  try {
    dateStyle = await scalar(query, "SHOW DateStyle");
    intervalStyle = await scalar(query, "SHOW IntervalStyle");
    timeZone = await scalar(query, "SHOW TimeZone");
    add("connectivity", "Database reachable", "pass", "The connection answers queries.");
  } catch (e) {
    add("connectivity", "Database reachable", "fail", `Could not query the database: ${err(e)}`);
    return { ok: false, environment, checks };
  }

  const dsFormat = (dateStyle.split(",")[0] ?? "").trim().toUpperCase();
  if (dsFormat === "ISO") {
    add("session-datestyle", "DateStyle is ISO", "pass", `DateStyle is "${dateStyle}". Dates arrive as YYYY-MM-DD.`);
  } else {
    add(
      "session-datestyle",
      "DateStyle is ISO",
      "fail",
      `DateStyle is "${dateStyle}". The date/timestamp codecs need ISO output. ` +
        `Fix: run SET DateStyle = 'ISO', or call configureTemporalSqlSession() at startup.`,
    );
  }

  const styles = ["postgres", "postgres_verbose", "iso_8601", "sql_standard"] as const;
  if ((styles as readonly string[]).includes(intervalStyle.trim().toLowerCase())) {
    add(
      "session-intervalstyle",
      "IntervalStyle is recognized",
      "pass",
      `IntervalStyle is "${intervalStyle}". All four styles decode; no change needed.`,
    );
  } else {
    add(
      "session-intervalstyle",
      "IntervalStyle is recognized",
      "fail",
      `IntervalStyle is "${intervalStyle}", which the interval codec does not recognize. ` +
        `Fix: SET IntervalStyle = 'iso_8601' (or any of: ${styles.join(", ")}).`,
    );
  }

  add(
    "session-timezone",
    "Session TimeZone noted",
    "pass",
    `TimeZone is "${timeZone}". This never changes what a timestamptz means — only how it prints — ` +
      `and the codecs read the printed offset, so any setting is safe.`,
  );

  // ---- server version ------------------------------------------------------
  try {
    const version = await scalar(query, "SHOW server_version");
    const major = parseInt(version, 10);
    if (Number.isNaN(major)) {
      add("server-version", "Server version known", "warn", `Could not parse server_version "${version}".`);
    } else if (major < 14) {
      add(
        "server-version",
        "Server version known",
        "warn",
        `Postgres ${version}. Everything works except multirange types, which need Postgres 14+.`,
      );
    } else {
      add("server-version", "Server version known", "pass", `Postgres ${version}. All mapped types are available.`);
    }
  } catch (e) {
    add("server-version", "Server version known", "warn", `SHOW server_version failed: ${err(e)}`);
  }

  // ---- local precision guard (no DB needed) --------------------------------
  try {
    const subMicro = TEMPORAL_CTORS.Instant.from("2024-01-01T00:00:00.000000123Z");
    let threw = false;
    try {
      encodeInstant(subMicro);
    } catch (e) {
      threw = e instanceof PrecisionError;
    }
    add(
      "precision-guard",
      "Sub-microsecond writes are guarded",
      threw ? "pass" : "fail",
      threw
        ? "Encoding a nanosecond-precision value throws PrecisionError instead of silently dropping digits."
        : "Encoding a nanosecond-precision value did NOT throw — precision could be lost silently.",
    );
  } catch (e) {
    add("precision-guard", "Sub-microsecond writes are guarded", "fail", err(e));
  }

  // ---- scalar round-trips: decode → encode → server → decode ---------------
  const canQueryIso = dsFormat === "ISO";
  type Roundtrip = {
    id: string;
    title: string;
    literal: string;
    sqlType: string;
    decode: (text: string) => unknown;
    encode: (value: never) => string;
    show: (value: unknown) => string;
  };
  const roundtrips: Roundtrip[] = [
    {
      id: "roundtrip-timestamptz",
      title: "timestamptz round-trips at microsecond precision",
      literal: "2024-01-01 12:34:56.123456+00",
      sqlType: "timestamptz",
      decode: decodeInstant,
      encode: encodeInstant as never,
      show: (v) => String(v),
    },
    {
      id: "roundtrip-timestamp",
      title: "timestamp round-trips at microsecond precision",
      literal: "2024-01-01 12:34:56.123456",
      sqlType: "timestamp",
      decode: decodePlainDateTime,
      encode: encodePlainDateTime as never,
      show: (v) => String(v),
    },
    {
      id: "roundtrip-date",
      title: "date round-trips",
      literal: "2024-02-29",
      sqlType: "date",
      decode: decodePlainDate,
      encode: encodePlainDate as never,
      show: (v) => String(v),
    },
    {
      id: "roundtrip-time",
      title: "time round-trips at microsecond precision",
      literal: "23:59:59.999999",
      sqlType: "time",
      decode: decodePlainTime,
      encode: encodePlainTime as never,
      show: (v) => String(v),
    },
    {
      id: "roundtrip-timetz",
      title: "timetz round-trips with its offset",
      literal: "12:00:00.000001+05:30",
      sqlType: "timetz",
      decode: decodeTimetz,
      encode: encodeTimetz as never,
      show: (v) => {
        const { time, offset } = v as { time: unknown; offset: string };
        return `${String(time)}${offset}`;
      },
    },
  ];
  for (const rt of roundtrips) {
    if (!canQueryIso) {
      add(rt.id, rt.title, "skip", "Skipped: DateStyle is not ISO, so decoded text would not be comparable.");
      continue;
    }
    try {
      const serverText = await scalar(query, `SELECT '${rt.literal}'::${rt.sqlType}::text`);
      const decoded = rt.decode(serverText);
      const reEncoded = (rt.encode as (value: unknown) => string)(decoded);
      const secondText = await scalar(query, `SELECT '${reEncoded}'::${rt.sqlType}::text`);
      const decodedAgain = rt.decode(secondText);
      if (rt.show(decoded) === rt.show(decodedAgain)) {
        add(rt.id, rt.title, "pass", `${rt.sqlType} '${rt.literal}' → ${rt.show(decoded)} → server → identical.`);
      } else {
        add(
          rt.id,
          rt.title,
          "fail",
          `Value changed across the round-trip: ${rt.show(decoded)} became ${rt.show(decodedAgain)}.`,
        );
      }
    } catch (e) {
      add(rt.id, rt.title, "fail", `Round-trip failed: ${err(e)}`);
    }
  }

  // ---- timezone independence ------------------------------------------------
  // The same timestamptz literal must decode to the same Instant under any
  // session TimeZone — this is the "no timezone surprises" claim, executed.
  if (canQueryIso) {
    const expected = "2024-06-01T00:00:00Z";
    const probe = async (zone: string): Promise<string> => {
      await query(`SET TimeZone = '${zone}'`);
      return String(decodeInstant(await scalar(query, `SELECT '2024-06-01 00:00:00+00'::timestamptz::text`)));
    };
    try {
      const utc = await probe("UTC");
      const tokyo = await probe("Asia/Tokyo");
      if (utc === expected && tokyo === expected) {
        add(
          "timezone-independence",
          "timestamptz is timezone-independent",
          "pass",
          "The same moment decoded to the identical Instant under TimeZone UTC and Asia/Tokyo.",
        );
      } else {
        add(
          "timezone-independence",
          "timestamptz is timezone-independent",
          "fail",
          `Decoded Instants differ by session TimeZone: UTC → ${utc}, Asia/Tokyo → ${tokyo} (expected ${expected}).`,
        );
      }
    } catch (e) {
      add("timezone-independence", "timestamptz is timezone-independent", "fail", err(e));
    } finally {
      if (timeZone && TZ_SAFE.test(timeZone)) {
        try {
          await query(`SET TimeZone = '${timeZone}'`);
        } catch {
          /* leave the connection as-is; it is doctor's own in the CLI */
        }
      }
    }
  } else {
    add("timezone-independence", "timestamptz is timezone-independent", "skip", "Skipped: DateStyle is not ISO.");
  }

  // ---- all four IntervalStyles ------------------------------------------------
  try {
    const failures: string[] = [];
    for (const style of styles) {
      await query(`SET IntervalStyle = '${style}'`);
      const text = await scalar(query, `SELECT interval '${INTERVAL_PROBE}'::text`);
      const decoded = String(decodeDuration(text));
      if (decoded !== INTERVAL_EXPECTED) failures.push(`${style}: "${text}" decoded to ${decoded}`);
    }
    if (failures.length === 0) {
      add(
        "interval-styles",
        "All four IntervalStyles decode",
        "pass",
        `postgres, postgres_verbose, iso_8601 and sql_standard all decoded to ${INTERVAL_EXPECTED}.`,
      );
    } else {
      add("interval-styles", "All four IntervalStyles decode", "fail", failures.join("; "));
    }
  } catch (e) {
    add("interval-styles", "All four IntervalStyles decode", "fail", err(e));
  } finally {
    const original = intervalStyle.trim().toLowerCase();
    if ((styles as readonly string[]).includes(original)) {
      try {
        await query(`SET IntervalStyle = '${original}'`);
      } catch {
        /* same as above */
      }
    }
  }

  // ---- driver / ORM compatibility notes ----------------------------------------
  const packages = opts.packages;
  if (packages) {
    const notes: string[] = [];
    const installed = (name: string): string | null | undefined => packages[name];
    if (installed("pg")) notes.push(`pg ${packages["pg"]}: supported (any 8.x).`);
    if (installed("postgres")) notes.push(`postgres.js ${packages["postgres"]}: supported (3.4+).`);
    if (installed("drizzle-orm")) {
      notes.push(
        `drizzle-orm ${packages["drizzle-orm"]}: supported — remember registerPassthrough() from "temporal-sql/pg" ` +
          `at startup; makePgTypes() alone is never consulted by Drizzle.`,
      );
    }
    if (installed("@prisma/client")) {
      notes.push(
        `@prisma/client ${packages["@prisma/client"]}: use the raw-SQL path — cast columns ::text and map with ` +
          `decodeRow() from "temporal-sql/prisma".`,
      );
    }
    add(
      "driver-compat",
      "Installed drivers/ORMs reviewed",
      "pass",
      notes.length > 0 ? notes.join(" ") : "No known driver or ORM packages were found next to temporal-sql.",
    );
  }

  return { ok: checks.every((c) => c.status !== "fail"), environment, checks };
}

const SYMBOL: Record<DoctorStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

/** Render a report for a terminal. */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("temporal-sql doctor");
  lines.push(
    `node ${report.environment.node ?? "unknown"} · Temporal: ${report.environment.temporalRuntime}` +
      Object.entries(report.environment.packages)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => ` · ${k} ${v}`)
        .join(""),
  );
  lines.push("");
  for (const check of report.checks) {
    lines.push(`${SYMBOL[check.status]} ${check.title}`);
    lines.push(`  ${check.detail}`);
  }
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of report.checks) counts[check.status]++;
  lines.push("");
  lines.push(
    `${counts.pass} passed, ${counts.warn} warned, ${counts.fail} failed, ${counts.skip} skipped — ` +
      (report.ok ? "this environment is compatible." : "fix the failed checks above."),
  );
  return lines.join("\n");
}

/** Render a report as a Markdown document (for CI job summaries, issues, docs). */
export function renderDoctorMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`# temporal-sql doctor — ${report.ok ? "compatible" : "problems found"}`);
  lines.push("");
  lines.push(`- Node: ${report.environment.node ?? "unknown"}`);
  lines.push(`- Temporal runtime: ${report.environment.temporalRuntime}`);
  for (const [name, version] of Object.entries(report.environment.packages)) {
    lines.push(`- ${name}: ${version ?? "not installed"}`);
  }
  lines.push("");
  lines.push("| Check | Status | Detail |");
  lines.push("|---|---|---|");
  for (const check of report.checks) {
    lines.push(`| ${check.title} | ${check.status} | ${check.detail.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}
