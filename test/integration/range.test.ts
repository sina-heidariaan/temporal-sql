/**
 * Real-Postgres round-trips for ranges and multiranges (v0.4.0), through both
 * `pg` and postgres.js. Gated on DATABASE_URL like the other integration
 * suites. This is the acceptance criterion for the release: all three range
 * types and their multiranges round-trip, with inclusivity flags, unbounded
 * sides, and `empty` intact.
 *
 * Multiranges need Postgres 14+; those tests skip themselves on older servers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import pg from "pg";
import postgres from "postgres";
import { registerTypeParsers, encode } from "../../src/pg.js";
import { makeTemporalTypes } from "../../src/postgres-js.js";
import type { TemporalRange } from "../../src/range.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const dateRange = (lower: string | null, upper: string | null, li = true, ui = false): TemporalRange<Temporal.PlainDate> => ({
  lower: lower === null ? null : Temporal.PlainDate.from(lower),
  upper: upper === null ? null : Temporal.PlainDate.from(upper),
  lowerInclusive: li,
  upperInclusive: ui,
  empty: false,
});

d("pg range round-trip", () => {
  let pool: pg.Pool;
  let serverMajor = 0;

  beforeAll(async () => {
    registerTypeParsers();
    pool = new pg.Pool({ connectionString: url });
    const { rows } = await pool.query("SHOW server_version");
    serverMajor = parseInt(String(rows[0]!.server_version), 10);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("daterange decodes with bounds, inclusivity, and canonicalization", async () => {
    // Postgres canonicalizes discrete ranges: [a,b] comes back [a,b+1).
    const { rows } = await pool.query("select '[2024-01-01,2024-01-05]'::daterange as v");
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDate>;
    expect(v.lower!.toString()).toBe("2024-01-01");
    expect(v.upper!.toString()).toBe("2024-01-06");
    expect(v.lowerInclusive).toBe(true);
    expect(v.upperInclusive).toBe(false);
    expect(v.empty).toBe(false);
  });

  it("daterange round-trips through encode.plainDateRange", async () => {
    const original = dateRange("2024-01-01", "2024-01-05");
    const { rows } = await pool.query("select $1::daterange as v", [encode.plainDateRange(original)]);
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDate>;
    expect(v.lower!.toString()).toBe("2024-01-01");
    expect(v.upper!.toString()).toBe("2024-01-05");
    expect(v.lowerInclusive).toBe(true);
    expect(v.upperInclusive).toBe(false);
  });

  it("unbounded and empty ranges survive", async () => {
    const unbounded = await pool.query("select '(,2024-01-05)'::daterange as v");
    const u = unbounded.rows[0]!.v as TemporalRange<Temporal.PlainDate>;
    expect(u.lower).toBeNull();
    expect(u.upper!.toString()).toBe("2024-01-05");

    const empty = await pool.query("select 'empty'::daterange as v");
    const e = empty.rows[0]!.v as TemporalRange<Temporal.PlainDate>;
    expect(e.empty).toBe(true);
    expect(e.lower).toBeNull();
    expect(e.upper).toBeNull();
  });

  it("tsrange → TemporalRange<PlainDateTime> preserves µs (quoted bounds)", async () => {
    const original: TemporalRange<Temporal.PlainDateTime> = {
      lower: Temporal.PlainDateTime.from("2024-01-01T00:00:00.123456"),
      upper: Temporal.PlainDateTime.from("2024-01-02T12:30:00.654321"),
      lowerInclusive: true,
      upperInclusive: false,
      empty: false,
    };
    const { rows } = await pool.query("select $1::tsrange as v", [encode.plainDateTimeRange(original)]);
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDateTime>;
    expect(v.lower!.toString()).toBe(original.lower!.toString());
    expect(v.upper!.toString()).toBe(original.upper!.toString());
  });

  it("tstzrange → TemporalRange<Instant> preserves µs across session timezones", async () => {
    const original: TemporalRange<Temporal.Instant> = {
      lower: Temporal.Instant.from("2024-03-10T07:30:45.123456Z"),
      upper: null,
      lowerInclusive: false,
      upperInclusive: false,
      empty: false,
    };
    const client = await pool.connect();
    try {
      await client.query("SET TimeZone = 'Asia/Tokyo'");
      const { rows } = await client.query("select $1::tstzrange as v", [encode.instantRange(original)]);
      const v = rows[0]!.v as TemporalRange<Temporal.Instant>;
      expect(v.lower!.toString()).toBe("2024-03-10T07:30:45.123456Z");
      expect(v.upper).toBeNull();
      expect(v.lowerInclusive).toBe(false);
    } finally {
      client.release();
    }
  });

  it("multiranges decode as TemporalRange[] and merge per Postgres semantics", async (ctx) => {
    if (serverMajor < 14) return ctx.skip();
    const disjoint = [dateRange("2024-01-01", "2024-01-05"), dateRange("2024-02-01", "2024-02-03")];
    const { rows } = await pool.query("select $1::datemultirange as v", [encode.plainDateMultirange(disjoint)]);
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDate>[];
    expect(v).toHaveLength(2);
    expect(v[0]!.lower!.toString()).toBe("2024-01-01");
    expect(v[1]!.upper!.toString()).toBe("2024-02-03");

    const empty = await pool.query("select '{}'::tstzmultirange as v");
    expect(empty.rows[0]!.v).toEqual([]);

    const merged = await pool.query(
      "select '{[2024-01-01,2024-01-05),[2024-01-03,2024-01-10)}'::datemultirange as v",
    );
    const m = merged.rows[0]!.v as TemporalRange<Temporal.PlainDate>[];
    expect(m).toHaveLength(1); // overlapping ranges merge
    expect(m[0]!.upper!.toString()).toBe("2024-01-10");
  });

  it("tsmultirange and tstzmultirange round-trip", async (ctx) => {
    if (serverMajor < 14) return ctx.skip();
    const ts = await pool.query(
      `select '{["2024-01-01 00:00:00.123456","2024-01-02 00:00:00")}'::tsmultirange as v`,
    );
    const tsv = ts.rows[0]!.v as TemporalRange<Temporal.PlainDateTime>[];
    expect(tsv[0]!.lower!.toString()).toBe("2024-01-01T00:00:00.123456");

    const instants: TemporalRange<Temporal.Instant>[] = [
      {
        lower: Temporal.Instant.from("2024-01-01T00:00:00Z"),
        upper: Temporal.Instant.from("2024-01-02T00:00:00Z"),
        lowerInclusive: true,
        upperInclusive: false,
        empty: false,
      },
    ];
    const tstz = await pool.query("select $1::tstzmultirange as v", [encode.instantMultirange(instants)]);
    const tv = tstz.rows[0]!.v as TemporalRange<Temporal.Instant>[];
    expect(tv[0]!.lower!.toString()).toBe("2024-01-01T00:00:00Z");
    expect(tv[0]!.upper!.toString()).toBe("2024-01-02T00:00:00Z");
  });
});

d("postgres.js range round-trip", () => {
  let sql: postgres.Sql;
  let serverMajor = 0;

  beforeAll(async () => {
    sql = postgres(url!, { types: makeTemporalTypes() });
    const rows = await sql`select current_setting('server_version') as v`;
    serverMajor = parseInt(String(rows[0]!.v), 10);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("daterange round-trips through sql.typed.plainDateRange", async () => {
    const original = dateRange("2024-01-01", "2024-01-05");
    const rows = await sql`select ${sql.typed.plainDateRange(original)}::daterange as v`;
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDate>;
    expect(v.lower!.toString()).toBe("2024-01-01");
    expect(v.upper!.toString()).toBe("2024-01-05");
    expect(v.lowerInclusive).toBe(true);
    expect(v.upperInclusive).toBe(false);
  });

  it("tstzrange round-trips with µs", async () => {
    const original: TemporalRange<Temporal.Instant> = {
      lower: Temporal.Instant.from("2024-03-10T07:30:45.123456Z"),
      upper: Temporal.Instant.from("2024-03-11T07:30:45.654321Z"),
      lowerInclusive: true,
      upperInclusive: true,
      empty: false,
    };
    const rows = await sql`select ${sql.typed.instantRange(original)}::tstzrange as v`;
    const v = rows[0]!.v as TemporalRange<Temporal.Instant>;
    expect(v.lower!.toString()).toBe("2024-03-10T07:30:45.123456Z");
    expect(v.upper!.toString()).toBe("2024-03-11T07:30:45.654321Z");
    expect(v.upperInclusive).toBe(true);
  });

  it("tsrange 'empty' decodes with empty: true", async () => {
    const rows = await sql`select 'empty'::tsrange as v`;
    expect((rows[0]!.v as TemporalRange<Temporal.PlainDateTime>).empty).toBe(true);
  });

  it("datemultirange round-trips disjoint ranges", async (ctx) => {
    if (serverMajor < 14) return ctx.skip();
    const disjoint = [dateRange("2024-01-01", "2024-01-05"), dateRange("2024-02-01", "2024-02-03")];
    const rows = await sql`select ${sql.typed.plainDateMultirange(disjoint)}::datemultirange as v`;
    const v = rows[0]!.v as TemporalRange<Temporal.PlainDate>[];
    expect(v).toHaveLength(2);
    expect(v[0]!.lower!.toString()).toBe("2024-01-01");
  });
});
