/**
 * Real-Postgres round-trip (insert → select) for `pg` and Drizzle.
 *
 * Gated on DATABASE_URL: skipped entirely when it is absent, so the default
 * `npm test` stays DB-free. CI sets it against a `postgres:18.4` service; locally
 * point it at any Postgres instance. Asserts every mapped type preserves its
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
import {
  decodeDuration,
  parsePgArray,
  decodeZonedDateTimeArray,
  MixedSignIntervalError,
  UnsupportedValueError,
  type TimeWithOffset,
} from "../../src/index.js";

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

  // Arrays. The point of these is the text Postgres actually emits: `interval[]`
  // elements come back quoted because they contain spaces, `date[]` elements come
  // back bare, and a SQL NULL element is the unquoted token `NULL`. A comma-split
  // would get the first and third of those wrong.
  it("timestamptz[] → Instant[] preserves µs", async () => {
    const values = [
      Temporal.Instant.from("2024-03-10T07:30:45.123456Z"),
      Temporal.Instant.from("1969-07-20T20:17:40.987654Z"),
    ];
    const res = await pool.query<{ v: Temporal.Instant[] }>("select $1::timestamptz[] as v", [
      encode.instantArray(values),
    ]);
    expect(res.rows[0]!.v.map((x) => x.toString())).toEqual(values.map((x) => x.toString()));
  });

  it("interval[] → Duration[] preserves µs through quoted elements", async () => {
    const values = [
      Temporal.Duration.from("P1Y2M3DT4H5M6.789012S"),
      Temporal.Duration.from("-P3DT4H5M6S"),
      Temporal.Duration.from("P400D"),
    ];
    const res = await pool.query<{ v: Temporal.Duration[]; raw: string }>(
      "select $1::interval[] as v, $1::interval[]::text as raw",
      [encode.durationArray(values)],
    );
    // Prove the driver really handed us quoted, space-bearing element text.
    expect(res.rows[0]!.raw).toContain('"');
    expect(res.rows[0]!.v.map((d) => d.total({ unit: "microseconds", relativeTo: REL }))).toEqual(
      values.map((d) => d.total({ unit: "microseconds", relativeTo: REL })),
    );
  });

  it("date[], timestamp[], time[] and timetz[] round-trip", async () => {
    const days = [Temporal.PlainDate.from("2024-02-29"), Temporal.PlainDate.from("1969-07-20")];
    const dateRes = await pool.query<{ v: Temporal.PlainDate[] }>("select $1::date[] as v", [
      encode.plainDateArray(days),
    ]);
    expect(dateRes.rows[0]!.v.map((x) => x.toString())).toEqual(days.map((x) => x.toString()));

    const stamps = [Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654")];
    const stampRes = await pool.query<{ v: Temporal.PlainDateTime[] }>("select $1::timestamp[] as v", [
      encode.plainDateTimeArray(stamps),
    ]);
    expect(stampRes.rows[0]!.v[0]!.toString()).toBe(stamps[0]!.toString());

    const times = [Temporal.PlainTime.from("12:34:56.789012")];
    const timeRes = await pool.query<{ v: Temporal.PlainTime[] }>("select $1::time[] as v", [
      encode.plainTimeArray(times),
    ]);
    expect(timeRes.rows[0]!.v[0]!.toString()).toBe(times[0]!.toString());

    const zoned: TimeWithOffset[] = [{ time: Temporal.PlainTime.from("12:34:56.789012"), offset: "+05:30" }];
    const zonedRes = await pool.query<{ v: TimeWithOffset[] }>("select $1::timetz[] as v", [
      encode.timetzArray(zoned),
    ]);
    expect(zonedRes.rows[0]!.v[0]!.time.toString()).toBe(zoned[0]!.time.toString());
    expect(zonedRes.rows[0]!.v[0]!.offset).toBe("+05:30");
  });

  it("arrays containing SQL NULL keep the nulls in place", async () => {
    const res = await pool.query<{ v: (Temporal.Duration | null)[] }>("select $1::interval[] as v", [
      encode.durationArray([Temporal.Duration.from("P1D"), null, Temporal.Duration.from("P2M")]),
    ]);
    const [a, b, c] = res.rows[0]!.v;
    expect(a!.days).toBe(1);
    expect(b).toBeNull();
    expect(c!.months).toBe(2);
  });

  it("empty arrays decode to []", async () => {
    for (const type of ["timestamptz", "timestamp", "date", "time", "timetz", "interval"]) {
      const res = await pool.query<{ v: unknown[] }>(`select '{}'::${type}[] as v`);
      expect(res.rows[0]!.v, type).toEqual([]);
    }
  });

  it("an array whose element text is literally NULL is not read as SQL NULL", async () => {
    // `array_out` quotes an element that would otherwise read as the NULL token,
    // so the distinction survives the round trip. Checked on `text[]` because no
    // date/time type can hold the string "NULL".
    const { rows } = await pool.query<{ raw: string }>(`select array['NULL', null]::text[]::text as raw`);
    expect(rows[0]!.raw).toBe('{"NULL",NULL}');
    expect(parsePgArray(rows[0]!.raw)).toEqual(["NULL", null]);
  });

  // The scalar suite proves decodeDuration reads every IntervalStyle. Arrays add
  // a second variable: whether array_out quotes the element. `iso_8601` produces
  // bare elements, the other three produce quoted ones — both paths must work.
  it("interval[] decodes under every IntervalStyle", async () => {
    const values = [Temporal.Duration.from("P1Y2M3DT4H5M6.789012S"), Temporal.Duration.from("-P3DT4H5M6S")];
    const expected = values.map((v) => v.total({ unit: "microseconds", relativeTo: REL }));

    for (const style of ["postgres", "postgres_verbose", "iso_8601", "sql_standard"]) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`set local intervalstyle = '${style}'`);
        const { rows } = await client.query<{ v: Temporal.Duration[]; raw: string }>(
          "select $1::interval[] as v, $1::interval[]::text as raw",
          [encode.durationArray(values)],
        );
        expect(
          rows[0]!.v.map((x) => x.total({ unit: "microseconds", relativeTo: REL })),
          `style=${style} raw=${rows[0]!.raw}`,
        ).toEqual(expected);
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }
    }
  });

  it("every array type keeps microsecond precision, exactly", async () => {
    // One table covering all six, each with a µs tail, asserted by exact value.
    const cases: Array<[type: string, literal: string, expected: string[]]> = [
      [
        "timestamptz",
        encode.instantArray([Temporal.Instant.from("2024-03-10T07:30:45.123456Z")]),
        ["2024-03-10T07:30:45.123456Z"],
      ],
      [
        "timestamp",
        encode.plainDateTimeArray([Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654")]),
        ["1969-07-20T20:17:40.987654"],
      ],
      ["date", encode.plainDateArray([Temporal.PlainDate.from("2024-02-29")]), ["2024-02-29"]],
      ["time", encode.plainTimeArray([Temporal.PlainTime.from("12:34:56.789012")]), ["12:34:56.789012"]],
    ];
    for (const [type, literal, expected] of cases) {
      const { rows } = await pool.query<{ v: { toString(): string }[] }>(`select $1::${type}[] as v`, [literal]);
      expect(rows[0]!.v.map((x) => x.toString()), type).toEqual(expected);
    }

    // timetz decodes to a struct, and interval compares by total, so both are
    // asserted on their own terms rather than by toString().
    const tzRes = await pool.query<{ v: TimeWithOffset[] }>("select $1::timetz[] as v", [
      encode.timetzArray([{ time: Temporal.PlainTime.from("12:34:56.789012"), offset: "+05:30" }]),
    ]);
    expect(tzRes.rows[0]!.v[0]!.time.toString()).toBe("12:34:56.789012");

    const ivRes = await pool.query<{ v: Temporal.Duration[] }>("select $1::interval[] as v", [
      encode.durationArray([Temporal.Duration.from("PT1S").add({ microseconds: 1 })]),
    ]);
    expect(ivRes.rows[0]!.v[0]!.total({ unit: "microseconds", relativeTo: REL })).toBe(1_000_001);
  });

  it("date[] round-trips a BC year", async () => {
    const bc = Temporal.PlainDate.from({ year: -43, month: 3, day: 15 });
    const res = await pool.query<{ v: Temporal.PlainDate[] }>("select $1::date[] as v", [
      encode.plainDateArray([bc, Temporal.PlainDate.from("2024-02-29")]),
    ]);
    expect(res.rows[0]!.v[0]!.year).toBe(-43);
    expect(res.rows[0]!.v[1]!.toString()).toBe("2024-02-29");
  });

  it("timetz[] keeps each element's own offset", async () => {
    const values: TimeWithOffset[] = [
      { time: Temporal.PlainTime.from("12:34:56.789012"), offset: "+05:30" },
      { time: Temporal.PlainTime.from("00:00:00"), offset: "-08:00" },
      { time: Temporal.PlainTime.from("23:59:59"), offset: "+00:00" },
    ];
    const res = await pool.query<{ v: TimeWithOffset[] }>("select $1::timetz[] as v", [
      encode.timetzArray(values),
    ]);
    expect(res.rows[0]!.v.map((x) => x.offset)).toEqual(["+05:30", "-08:00", "+00:00"]);
    expect(res.rows[0]!.v.map((x) => x.time.toString())).toEqual(values.map((x) => x.time.toString()));
  });

  it("a NULL column is null, which is not the same as an empty array", async () => {
    const { rows } = await pool.query<{ nothing: unknown; empty: unknown[] }>(
      "select null::interval[] as nothing, '{}'::interval[] as empty",
    );
    expect(rows[0]!.nothing).toBeNull();
    expect(rows[0]!.empty).toEqual([]);
  });

  it("reads an array whose lower bound is not 1 (dimension prefix)", async () => {
    const { rows } = await pool.query<{ v: Temporal.PlainDate[]; raw: string }>(
      "select $1::date[] as v, $1::date[]::text as raw",
      ["[2:4]={2024-01-01,2024-01-02,2024-01-03}"],
    );
    // Prove Postgres really emitted the prefix, then that we dropped it correctly.
    expect(rows[0]!.raw).toMatch(/^\[2:4]=/);
    expect(rows[0]!.v.map((x) => x.toString())).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
  });

  it("a multidimensional array reports the limitation instead of mis-mapping", async () => {
    await expect(
      pool.query("select array[array['1 day'::interval], array['2 days'::interval]] as v"),
    ).rejects.toThrow(/[Mm]ultidimensional/);
  });

  it("an element with no Temporal value still throws, from inside the array", async () => {
    await expect(pool.query("select array['infinity'::timestamptz] as v")).rejects.toThrow(
      UnsupportedValueError,
    );
  });

  it("a mixed-sign interval element throws, from inside the array", async () => {
    await expect(pool.query("select array['1 mon -3 days'::interval] as v")).rejects.toThrow(
      MixedSignIntervalError,
    );
  });

  it("round-trips a 1000-element array", async () => {
    const values = Array.from({ length: 1000 }, (_, n) => Temporal.PlainDate.from("2024-01-01").add({ days: n }));
    const res = await pool.query<{ v: Temporal.PlainDate[] }>("select $1::date[] as v", [
      encode.plainDateArray(values),
    ]);
    expect(res.rows[0]!.v).toHaveLength(1000);
    expect(res.rows[0]!.v[0]!.toString()).toBe("2024-01-01");
    expect(res.rows[0]!.v[999]!.toString()).toBe(values[999]!.toString());
  });

  it("timestamptz[] can be projected onto a zone with decodeZonedDateTimeArray", async () => {
    const { rows } = await pool.query<{ raw: string }>(
      "select array['2024-03-10 07:30:45.123456+00'::timestamptz, null]::text as raw",
    );
    const zoned = decodeZonedDateTimeArray(rows[0]!.raw, "Europe/Berlin");
    expect(zoned[0]!.timeZoneId).toBe("Europe/Berlin");
    expect(zoned[0]!.toInstant().toString()).toBe("2024-03-10T07:30:45.123456Z");
    expect(zoned[1]).toBeNull();
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
    ats: t.timestamptzArray()("ats"),
    spans: t.intervalArray()("spans"),
    days: t.dateArray()("days"),
    stamps: t.timestampArray()("stamps"),
    // `time[]` and `timetz[]` matter most here: no Drizzle version passes their
    // OIDs through, so they only work because registerPassthrough() mutated pg's
    // global table. They are the sharpest test that the documented setup is right.
    clocks: t.timeArray()("clocks"),
    zoned: t.timetzArray()("zoned"),
  });

  beforeAll(async () => {
    // Drizzle custom columns need raw text from pg, not a decoded Date.
    registerPassthrough();
    pool = new pg.Pool({ connectionString: url });
    const db = drizzle(pool);
    await db.execute(sql`drop table if exists events_ts`);
    await db.execute(
      sql`create table events_ts (
            at timestamptz, span interval, day date,
            ats timestamptz[], spans interval[], days date[],
            stamps timestamp[], clocks time[], zoned timetz[]
          )`,
    );
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

    await db.insert(events).values({
      at,
      span,
      day,
      ats: [at],
      spans: [span],
      days: [day],
      stamps: [Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654")],
      clocks: [Temporal.PlainTime.from("12:34:56.789012")],
      zoned: [{ time: Temporal.PlainTime.from("12:34:56.789012"), offset: "+05:30" }],
    });
    const [row] = await db.select().from(events);

    expect(row!.at.toString()).toBe(at.toString());
    expect(row!.day.toString()).toBe(day.toString());
    expect(row!.span.total({ unit: "microseconds", relativeTo: REL })).toBe(
      span.total({ unit: "microseconds", relativeTo: REL }),
    );
  });

  it("inserts and selects array columns, including NULL and empty", async () => {
    const db = drizzle(pool);
    await db.execute(sql`delete from events_ts`);

    const at = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
    const span = Temporal.Duration.from("P1Y2M3DT4H5M6.789012S");
    const day = Temporal.PlainDate.from("2024-02-29");

    const stamp = Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654");
    const clock = Temporal.PlainTime.from("12:34:56.789012");
    const tz: TimeWithOffset = { time: clock, offset: "+05:30" };

    await db.insert(events).values({
      at,
      span,
      day,
      ats: [at, null],
      spans: [span, Temporal.Duration.from("-P3DT4H")],
      days: [],
      stamps: [stamp, null],
      clocks: [clock, null],
      zoned: [tz, null],
    });
    const [row] = await db.select().from(events);

    expect(row!.ats[0]!.toString()).toBe(at.toString());
    expect(row!.ats[1]).toBeNull();
    expect(row!.spans[0]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
      span.total({ unit: "microseconds", relativeTo: REL }),
    );
    expect(row!.spans[1]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
      Temporal.Duration.from("-P3DT4H").total({ unit: "microseconds", relativeTo: REL }),
    );
    expect(row!.days).toEqual([]);

    // The two Drizzle never passes through, at any version.
    expect(row!.stamps[0]!.toString()).toBe(stamp.toString());
    expect(row!.stamps[1]).toBeNull();
    expect(row!.clocks[0]!.toString()).toBe(clock.toString());
    expect(row!.clocks[1]).toBeNull();
    expect(row!.zoned[0]!.time.toString()).toBe(clock.toString());
    expect(row!.zoned[0]!.offset).toBe("+05:30");
    expect(row!.zoned[1]).toBeNull();
  });
});
