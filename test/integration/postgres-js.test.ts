/**
 * Real-Postgres round-trip for the postgres.js adapter. Gated on DATABASE_URL,
 * like the pg/Drizzle suite. Proves the shared codecs work end-to-end through
 * postgres.js's `types` option too (not just pg), so the driver claim holds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import postgres from "postgres";
import { temporalTypes } from "../../src/postgres-js.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const REL = "2000-01-01";

d("postgres.js round-trip", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(url!, { types: temporalTypes });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("timestamptz → Instant preserves µs", async () => {
    const original = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
    const rows = await sql`select ${sql.typed.instant(original)}::timestamptz as v`;
    expect((rows[0]!.v as Temporal.Instant).toString()).toBe(original.toString());
  });

  it("interval → Duration preserves µs (incl. negative)", async () => {
    for (const iso of ["P1Y2M3DT4H5M6.789012S", "-P3DT4H5M6S"]) {
      const original = Temporal.Duration.from(iso);
      const rows = await sql`select ${sql.typed.duration(original)}::interval as v`;
      expect((rows[0]!.v as Temporal.Duration).total({ unit: "microseconds", relativeTo: REL })).toBe(
        original.total({ unit: "microseconds", relativeTo: REL }),
      );
    }
  });

  it("date → PlainDate round-trips", async () => {
    const original = Temporal.PlainDate.from("2024-02-29");
    const rows = await sql`select ${sql.typed.plainDate(original)}::date as v`;
    expect((rows[0]!.v as Temporal.PlainDate).toString()).toBe(original.toString());
  });

  // postgres.js can also derive an array parser for a registered scalar type by
  // querying pg_catalog. These assert that our explicit registration is the one
  // that wins, so behaviour does not depend on that catalog round trip.
  it("timestamptz[] → Instant[] round-trips", async () => {
    const values = [
      Temporal.Instant.from("2024-03-10T07:30:45.123456Z"),
      Temporal.Instant.from("1969-07-20T20:17:40.987654Z"),
    ];
    const rows = await sql`select ${sql.typed.instantArray(values)}::timestamptz[] as v`;
    expect((rows[0]!.v as Temporal.Instant[]).map((x) => x.toString())).toEqual(
      values.map((x) => x.toString()),
    );
  });

  it("interval[] → Duration[] round-trips, NULL elements included", async () => {
    const values = [Temporal.Duration.from("P1Y2M3DT4H5M6.789012S"), null, Temporal.Duration.from("-P3DT4H")];
    const rows = await sql`select ${sql.typed.durationArray(values)}::interval[] as v`;
    const out = rows[0]!.v as (Temporal.Duration | null)[];
    expect(out[1]).toBeNull();
    expect(out[0]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
      values[0]!.total({ unit: "microseconds", relativeTo: REL }),
    );
    expect(out[2]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
      values[2]!.total({ unit: "microseconds", relativeTo: REL }),
    );
  });

  it("empty date[] decodes to []", async () => {
    const rows = await sql`select ${sql.typed.plainDateArray([])}::date[] as v`;
    expect(rows[0]!.v).toEqual([]);
  });

  it("the remaining array types round-trip too", async () => {
    const stamps = [Temporal.PlainDateTime.from("1969-07-20T20:17:40.987654")];
    const stampRows = await sql`select ${sql.typed.plainDateTimeArray(stamps)}::timestamp[] as v`;
    expect((stampRows[0]!.v as Temporal.PlainDateTime[])[0]!.toString()).toBe(stamps[0]!.toString());

    const times = [Temporal.PlainTime.from("12:34:56.789012"), null];
    const timeRows = await sql`select ${sql.typed.plainTimeArray(times)}::time[] as v`;
    const timesOut = timeRows[0]!.v as (Temporal.PlainTime | null)[];
    expect(timesOut[0]!.toString()).toBe("12:34:56.789012");
    expect(timesOut[1]).toBeNull();

    const zoned = [{ time: Temporal.PlainTime.from("12:34:56.789012"), offset: "-08:00" }];
    const zonedRows = await sql`select ${sql.typed.timetzArray(zoned)}::timetz[] as v`;
    const zonedOut = zonedRows[0]!.v as { time: Temporal.PlainTime; offset: string }[];
    expect(zonedOut[0]!.offset).toBe("-08:00");
    expect(zonedOut[0]!.time.toString()).toBe("12:34:56.789012");
  });

  it("a NULL array column stays null, distinct from an empty array", async () => {
    const rows = await sql`select null::interval[] as nothing, '{}'::interval[] as empty`;
    expect(rows[0]!.nothing).toBeNull();
    expect(rows[0]!.empty).toEqual([]);
  });

  it("reports the limitation for a multidimensional array", async () => {
    await expect(
      sql`select array[array['1 day'::interval], array['2 days'::interval]] as v`,
    ).rejects.toThrow(/[Mm]ultidimensional/);
  });
});
