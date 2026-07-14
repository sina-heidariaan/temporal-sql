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
});
