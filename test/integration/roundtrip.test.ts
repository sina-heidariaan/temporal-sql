/**
 * Real-Postgres round-trip (insert → select) for `pg` and Drizzle.
 *
 * Gated on DATABASE_URL: skipped entirely when it is absent, so the default
 * `npm test` stays DB-free. CI sets it against a `postgres:16` service; locally
 * point it at any Postgres 16 instance. Asserts every mapped type preserves its
 * value to microsecond precision — the package's acceptance criterion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { registerTypeParsers, registerPassthrough, encode } from "../../src/pg.js";
import * as t from "../../src/drizzle.js";
import { decodeDuration, MixedSignIntervalError, type TimeWithOffset } from "../../src/index.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const REL = "2000-01-01"; // fixed relativeTo for calendar-safe Duration totals

d("pg round-trip (registerTypeParsers → Temporal on select)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    // Real adapter path: pg decodes date/time OIDs to Temporal automatically.
    registerTypeParsers();
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("timestamptz → Instant preserves µs", async () => {
    const original = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
    const res = await pool.query<{ v: Temporal.Instant }>("select $1::timestamptz as v", [encode.instant(original)]);
    expect(res.rows[0]!.v.toString()).toBe(original.toString());
  });

  it("timestamp → PlainDateTime preserves µs", async () => {
    const original = Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654");
    const res = await pool.query<{ v: Temporal.PlainDateTime }>("select $1::timestamp as v", [encode.plainDateTime(original)]);
    expect(res.rows[0]!.v.toString()).toBe(original.toString());
  });

  it("date → PlainDate round-trips (incl. BC)", async () => {
    for (const iso of ["2024-02-29", "1969-07-20"]) {
      const original = Temporal.PlainDate.from(iso);
      const res = await pool.query<{ v: Temporal.PlainDate }>("select $1::date as v", [encode.plainDate(original)]);
      expect(res.rows[0]!.v.toString()).toBe(original.toString());
    }
    const bc = Temporal.PlainDate.from({ year: -43, month: 3, day: 15 });
    const res = await pool.query<{ v: Temporal.PlainDate }>("select $1::date as v", [encode.plainDate(bc)]);
    expect(res.rows[0]!.v.year).toBe(-43);
  });

  it("time → PlainTime preserves µs", async () => {
    const original = Temporal.PlainTime.from("12:34:56.789012");
    const res = await pool.query<{ v: Temporal.PlainTime }>("select $1::time as v", [encode.plainTime(original)]);
    expect(res.rows[0]!.v.toString()).toBe(original.toString());
  });

  it("timetz → { time, offset } round-trips", async () => {
    const original: TimeWithOffset = { time: Temporal.PlainTime.from("12:34:56.789012"), offset: "+05:30" };
    const res = await pool.query<{ v: TimeWithOffset }>("select $1::timetz as v", [encode.timetz(original)]);
    expect(res.rows[0]!.v.time.toString()).toBe(original.time.toString());
    expect(res.rows[0]!.v.offset).toBe(original.offset);
  });

  it("interval → Duration preserves µs (positive, negative, fractional)", async () => {
    for (const iso of ["P1Y2M3DT4H5M6.789012S", "-P3DT4H5M6S", "PT0.5S", "P400D"]) {
      const original = Temporal.Duration.from(iso);
      const res = await pool.query<{ v: Temporal.Duration }>("select $1::interval as v", [encode.duration(original)]);
      expect(res.rows[0]!.v.total({ unit: "microseconds", relativeTo: REL })).toBe(
        original.total({ unit: "microseconds", relativeTo: REL }),
      );
    }
  });

  // decodeDuration claims to parse "the exact grammars Postgres emits". The
  // strict tokenizer (v0.1.1) can only honor that claim if it is checked against
  // interval_out itself, across every IntervalStyle — including the zero values,
  // where postgres_verbose emits the bare token `@ 0`.
  it("parses interval_out across every supported IntervalStyle", async () => {
    // Expectations are independent of the parser: each is what the interval
    // means, asserted against whatever text the given IntervalStyle renders.
    const cases: Array<[input: string, expected: string]> = [
      ["1 year 2 mons 3 days 4:05:06.789012", "P1Y2M3DT4H5M6.789012S"], // mixed
      ["-3 days -4:05:06", "-P3DT4H5M6S"], // negative day-time
      ["1 year 2 mons", "P1Y2M"], // year-month-only
      ["3 days 4:05:06", "P3DT4H5M6S"], // day-time-only
      ["0", "PT0S"], // zero (sql_standard renders this as bare `0`)
      ["1 day", "P1D"],
      ["400 days", "P400D"],
    ];
    const total = (v: Temporal.Duration) => v.total({ unit: "microseconds", relativeTo: REL });

    for (const style of ["postgres", "postgres_verbose", "iso_8601", "sql_standard"]) {
      const client = await pool.connect();
      try {
        // `set local` inside a transaction: a plain `set` would survive
        // release() and leak the style into whichever test reuses the connection.
        await client.query("begin");
        await client.query(`set local intervalstyle = '${style}'`);
        for (const [input, expected] of cases) {
          // `raw` is the text interval_out actually produced; `v` is that same
          // text after registerTypeParsers ran it through decodeDuration.
          const { rows } = await client.query<{ raw: string; v: Temporal.Duration }>(
            "select $1::interval::text as raw, $1::interval as v",
            [input],
          );
          const { raw, v } = rows[0]!;
          expect(total(v), `style=${style} input="${input}" raw="${raw}"`).toBe(
            total(Temporal.Duration.from(expected)),
          );
        }
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }
    }
  });

  // A mixed-sign interval (`1 mon -3 days`) is real Postgres output but cannot be
  // one Temporal.Duration. Verify the sql_standard rendering PG emits for it still
  // trips MixedSignIntervalError rather than silently misparsing.
  it("mixed-sign sql_standard interval throws MixedSignIntervalError", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local intervalstyle = 'sql_standard'");
      const { rows } = await client.query<{ raw: string }>("select '1 mon -3 days'::interval::text as raw");
      expect(() => decodeDuration(rows[0]!.raw)).toThrow(MixedSignIntervalError);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});

d("drizzle round-trip", () => {
  let pool: pg.Pool;

  const events = pgTable("events_ts", {
    at: t.timestamptz()("at"),
    span: t.interval()("span"),
    day: t.date()("day"),
  });

  beforeAll(async () => {
    // Drizzle custom columns need raw text from pg, not a decoded Date.
    registerPassthrough();
    pool = new pg.Pool({ connectionString: url });
    const db = drizzle(pool);
    await db.execute(sql`drop table if exists events_ts`);
    await db.execute(sql`create table events_ts (at timestamptz, span interval, day date)`);
  });
  afterAll(async () => {
    await pool?.query("drop table if exists events_ts");
    await pool?.end();
  });

  it("inserts and selects Temporal values through custom columns", async () => {
    const db = drizzle(pool);
    const at = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
    const span = Temporal.Duration.from("P1Y2M3DT4H5M6.789012S");
    const day = Temporal.PlainDate.from("2024-02-29");

    await db.insert(events).values({ at, span, day });
    const [row] = await db.select().from(events);

    expect(row!.at.toString()).toBe(at.toString());
    expect(row!.day.toString()).toBe(day.toString());
    expect(row!.span.total({ unit: "microseconds", relativeTo: REL })).toBe(
      span.total({ unit: "microseconds", relativeTo: REL }),
    );
  });
});
