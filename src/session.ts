/**
 * Session-compatibility helpers.
 *
 * The codecs assume the connection emits date/time text in the formats they
 * parse: an ISO `DateStyle` (so `date`/`timestamp` render `YYYY-MM-DD ...`) and
 * one of the four supported `IntervalStyle`s. A mismatch surfaces late, as a
 * cryptic per-value parse error (`Unparseable date: "01-15-2024"`). These
 * helpers turn that into an actionable, up-front diagnostic, and can set a
 * known-good session for you.
 *
 * Everything here operates **per connection** (a `SET` affects only the session
 * that runs it), never globally — pass the specific pool connection you query
 * on. There are no driver dependencies: you supply a minimal query function, so
 * the same helpers work with `pg`, `postgres.js`, and Drizzle's client.
 */
import { UnsupportedValueError } from "./shared.js";

/** A single result row: a map of column name to value. */
type Row = Record<string, unknown>;

/**
 * Whatever your driver's query returns. Normalized internally, so both shapes
 * work: `pg`/Drizzle's `{ rows }` and `postgres.js`'s bare row array.
 */
export type SessionResult = readonly Row[] | { rows: readonly Row[] };

/**
 * The minimal query surface the helpers need: a function that runs one SQL
 * string and resolves the result. Adapt your driver in a one-line lambda:
 *
 *   pg:          (t) => pool.query(t)
 *   postgres.js: (t) => sql.unsafe(t)
 *   drizzle:     (t) => db.execute(sql.raw(t))
 */
export type SessionQuery = (sql: string) => Promise<SessionResult>;

/** The session settings the codecs care about, as reported by `SHOW`. */
export interface SessionDiagnostic {
  /** Raw `SHOW DateStyle`, e.g. `"ISO, MDY"`. Only the format token (`ISO`) is required. */
  dateStyle: string;
  /** Raw `SHOW IntervalStyle`, e.g. `"postgres"`. All four styles decode. */
  intervalStyle: string;
  /** Raw `SHOW TimeZone`, e.g. `"UTC"`. Informational — `timestamptz` carries an explicit offset. */
  timeZone: string;
}

/** The `IntervalStyle` values {@link decodeDuration} understands — i.e. every one Postgres emits. */
const ACCEPTED_INTERVAL_STYLES = ["postgres", "postgres_verbose", "iso_8601", "sql_standard"] as const;

/** Values {@link configureTemporalSqlSession} may write. Allowlisted because `SET <guc>` can't be parameterized. */
export type IntervalStyle = (typeof ACCEPTED_INTERVAL_STYLES)[number];

export interface ConfigureOptions {
  /** Only `"ISO"` produces the `YYYY-MM-DD` output the date/timestamp codecs parse. Default `"ISO"`. */
  dateStyle?: "ISO";
  /** Any of the four supported styles. Default `"iso_8601"`. */
  intervalStyle?: IntervalStyle;
  /** Optional IANA zone to `SET TimeZone`. Left untouched when omitted. */
  timeZone?: string;
}

/** Extract the row array from either result shape. */
function rowsOf(result: SessionResult): readonly Row[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: readonly Row[] }).rows;
  if (Array.isArray(rows)) return rows;
  throw new UnsupportedValueError(
    "Session query returned an unrecognized shape (expected a row array or { rows: [...] }).",
  );
}

/** Run `SHOW <setting>` and return its single scalar value (by position, ignoring the column name). */
async function show(query: SessionQuery, setting: string): Promise<string> {
  const rows = rowsOf(await query(`SHOW ${setting}`));
  const first = rows[0];
  if (!first) throw new UnsupportedValueError(`SHOW ${setting} returned no rows.`);
  return String(Object.values(first)[0]);
}

/**
 * Inspect the connection's `DateStyle`, `IntervalStyle`, and `TimeZone` and
 * verify they are compatible with the codecs.
 *
 * @returns the observed settings on success.
 * @throws {UnsupportedValueError} naming the offending setting and the accepted
 *   values when `DateStyle` is not ISO or `IntervalStyle` is unrecognized.
 */
export async function assertTemporalSqlSession(query: SessionQuery): Promise<SessionDiagnostic> {
  const [dateStyle, intervalStyle, timeZone] = await Promise.all([
    show(query, "DateStyle"),
    show(query, "IntervalStyle"),
    show(query, "TimeZone"),
  ]);

  // `DateStyle` is `<format>, <order>` (e.g. `ISO, MDY`); only the format matters,
  // and only ISO renders `date`/`timestamp` as the `YYYY-MM-DD` the codecs parse.
  const format = (dateStyle.split(",")[0] ?? "").trim().toUpperCase();
  if (format !== "ISO") {
    throw new UnsupportedValueError(
      `DateStyle is "${dateStyle}", but temporal-sql needs ISO date output. ` +
        `Call configureTemporalSqlSession(query), or run: SET DateStyle = 'ISO'.`,
    );
  }

  const style = intervalStyle.trim().toLowerCase();
  if (!(ACCEPTED_INTERVAL_STYLES as readonly string[]).includes(style)) {
    throw new UnsupportedValueError(
      `IntervalStyle is "${intervalStyle}", which temporal-sql does not recognize. ` +
        `Accepted: ${ACCEPTED_INTERVAL_STYLES.join(", ")}.`,
    );
  }

  return { dateStyle, intervalStyle, timeZone };
}

/**
 * Set a known-compatible session on this connection (`DateStyle = ISO`,
 * `IntervalStyle = iso_8601` by default), then assert and return the result.
 *
 * Values are allowlisted rather than parameterized, because `SET <guc>` does not
 * accept bind parameters — anything outside the allowlist throws instead of
 * being interpolated.
 */
export async function configureTemporalSqlSession(
  query: SessionQuery,
  opts: ConfigureOptions = {},
): Promise<SessionDiagnostic> {
  const dateStyle = opts.dateStyle ?? "ISO";
  const intervalStyle = opts.intervalStyle ?? "iso_8601";

  if (dateStyle !== "ISO") {
    throw new UnsupportedValueError(`Unsupported dateStyle "${dateStyle}"; only "ISO" is compatible.`);
  }
  if (!(ACCEPTED_INTERVAL_STYLES as readonly string[]).includes(intervalStyle)) {
    throw new UnsupportedValueError(
      `Unsupported intervalStyle "${intervalStyle}". Accepted: ${ACCEPTED_INTERVAL_STYLES.join(", ")}.`,
    );
  }

  await query(`SET DateStyle = 'ISO'`);
  await query(`SET IntervalStyle = '${intervalStyle}'`);
  if (opts.timeZone !== undefined) {
    // A named zone contains only these characters; reject anything else rather than interpolate it.
    if (!/^[A-Za-z0-9_+\-/:.]+$/.test(opts.timeZone)) {
      throw new UnsupportedValueError(`Unsupported timeZone "${opts.timeZone}".`);
    }
    await query(`SET TimeZone = '${opts.timeZone}'`);
  }

  return assertTemporalSqlSession(query);
}
