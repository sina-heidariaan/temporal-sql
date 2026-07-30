/**
 * `makePgTypes` — decoding scoped to one pool, with no global mutation.
 *
 * This lives in its own file on purpose. `registerTypeParsers()` /
 * `registerPassthrough()` mutate pg's process-wide table, and the other
 * integration suites call them. Vitest gives each test file its own module
 * registry, so this file observes a pristine pg and the comparison against an
 * unconfigured pool is meaningful.
 *
 * Gated on DATABASE_URL like the other integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { makePgTypes } from "../../src/pg.js";
import * as t from "../../src/drizzle.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const REL = "2000-01-01";

d("makePgTypes (per-pool, no globals)", () => {
  let scoped: pg.Pool;
  let plain: pg.Pool;

  beforeAll(() => {
    scoped = new pg.Pool({ connectionString: url, types: makePgTypes() });
    plain = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await Promise.all([scoped?.end(), plain?.end()]);
  });

  it("the configured pool returns Temporal values", async () => {
    const res = await scoped.query<{ v: Temporal.Instant }>(
      "select '2024-03-10 07:30:45.123456+00'::timestamptz as v",
    );
    expect(res.rows[0]!.v).toBeInstanceOf(Temporal.Instant);
    expect(res.rows[0]!.v.toString()).toBe("2024-03-10T07:30:45.123456Z");
  });

  it("the configured pool decodes arrays too", async () => {
    const res = await scoped.query<{ v: (Temporal.Duration | null)[] }>(
      "select array['1 day'::interval, null] as v",
    );
    expect(res.rows[0]!.v[0]!.days).toBe(1);
    expect(res.rows[0]!.v[1]).toBeNull();
  });

  it("a second, unconfigured pool is completely unaffected", async () => {
    // This is the whole point: no global was mutated, so pg's own parser still
    // runs here and still produces a JS Date.
    const res = await plain.query<{ v: unknown }>("select '2024-03-10 07:30:45.123456+00'::timestamptz as v");
    expect(res.rows[0]!.v).toBeInstanceOf(Date);
    expect(res.rows[0]!.v).not.toBeInstanceOf(Temporal.Instant);
  });

  it("non-date OIDs still use pg's own parsers on the configured pool", async () => {
    const res = await scoped.query<{ n: number; s: string; b: boolean }>(
      "select 42::int4 as n, 'hi'::text as s, true as b",
    );
    expect(res.rows[0]).toEqual({ n: 42, s: "hi", b: true });
  });

  // Measured limitation, pinned so it is not rediscovered the hard way.
  //
  // drizzle-orm's node-postgres driver attaches its own `types` object to every
  // query it sends (`drizzle-orm/node-postgres/session.js`). That per-query
  // object wins over the pool's, and it only passes through four scalar OIDs
  // (timestamptz, timestamp, date, interval) — everything else, including all
  // six array OIDs, it hands to pg's **global** parser table.
  //
  // So a pool-scoped `types` cannot drive the Drizzle columns. Drizzle users
  // still need `registerPassthrough()`, which mutates exactly that global table.
  // `makePgTypes` remains the right tool for plain `pg`, as the tests above show.
  it("cannot drive Drizzle array columns — drizzle overrides pool types per query", async () => {
    const pool = new pg.Pool({
      connectionString: url,
      types: makePgTypes({ mode: "passthrough" }),
    });
    const events = pgTable("events_scoped", {
      at: t.timestamptz()("at"),
      spans: t.intervalArray()("spans"),
    });
    try {
      const db = drizzle(pool);
      await db.execute(sql`drop table if exists events_scoped`);
      await db.execute(sql`create table events_scoped (at timestamptz, spans interval[])`);

      const at = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
      const span = Temporal.Duration.from("P1Y2M3DT4H5M6.789012S");
      await db.insert(events).values({ at, spans: [span, null] });

      // `at` happens to work: OID 1184 is one drizzle passes through at every
      // version. `spans` does not on 0.36: pg's global parser turns interval[]
      // into plain objects before the column's fromDriver ever sees text.
      //
      // The error must name the actual fix, not just "malformed array" — this is
      // the exact situation that diagnostic exists for.
      await expect(db.select().from(events)).rejects.toThrow(/registerPassthrough/);

      await db.execute(sql`drop table if exists events_scoped`);
    } finally {
      await pool.end();
    }
  });

  // The practical question: can one app use makePgTypes for its own pg pools and
  // registerPassthrough for Drizzle at the same time? Yes — they are independent.
  it("coexists with a global registerPassthrough", async () => {
    const { registerPassthrough } = await import("../../src/pg.js");
    const restore = registerPassthrough();

    const configured = new pg.Pool({ connectionString: url, types: makePgTypes() });
    const inherits = new pg.Pool({ connectionString: url });
    try {
      // The configured pool answers from its own table, so the global
      // passthrough cannot reach it — still Temporal.
      const a = await configured.query<{ v: Temporal.Instant }>(
        "select '2024-03-10 07:30:45.123456+00'::timestamptz as v",
      );
      expect(a.rows[0]!.v).toBeInstanceOf(Temporal.Instant);

      const arr = await configured.query<{ v: Temporal.Duration[] }>("select array['1 day'::interval] as v");
      expect(arr.rows[0]!.v[0]!.days).toBe(1);

      // A pool with no `types` shares the global table, so it sees raw text.
      // This is the one thing to know when combining the two.
      const b = await inherits.query<{ v: unknown }>(
        "select '2024-03-10 07:30:45.123456+00'::timestamptz as v",
      );
      expect(typeof b.rows[0]!.v).toBe("string");
    } finally {
      restore();
      await Promise.all([configured.end(), inherits.end()]);
    }
  });

  it("registration is reversible — restore() puts pg's own parsers back", async () => {
    const { registerTypeParsers } = await import("../../src/pg.js");
    const before = new pg.Pool({ connectionString: url });
    try {
      const original = await before.query<{ v: unknown }>("select now()::timestamptz as v");
      expect(original.rows[0]!.v).toBeInstanceOf(Date);

      const restore = registerTypeParsers();
      const during = await before.query<{ v: unknown }>("select now()::timestamptz as v");
      expect(during.rows[0]!.v).toBeInstanceOf(Temporal.Instant);

      restore();
      const after = await before.query<{ v: unknown }>("select now()::timestamptz as v");
      expect(after.rows[0]!.v).toBeInstanceOf(Date);

      restore(); // calling twice is harmless
      const again = await before.query<{ v: unknown }>("select now()::timestamptz as v");
      expect(again.rows[0]!.v).toBeInstanceOf(Date);
    } finally {
      await before.end();
    }
  });

  it("registerPassthrough IS the supported path for Drizzle arrays", async () => {
    // Same table, same columns — the only change is mutating pg's global table,
    // which is the one lever drizzle's per-query fallback consults.
    const { registerPassthrough } = await import("../../src/pg.js");
    registerPassthrough();

    const pool = new pg.Pool({ connectionString: url });
    const events = pgTable("events_scoped2", {
      at: t.timestamptz()("at"),
      spans: t.intervalArray()("spans"),
    });
    try {
      const db = drizzle(pool);
      await db.execute(sql`drop table if exists events_scoped2`);
      await db.execute(sql`create table events_scoped2 (at timestamptz, spans interval[])`);

      const at = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
      const span = Temporal.Duration.from("P1Y2M3DT4H5M6.789012S");
      await db.insert(events).values({ at, spans: [span, null] });
      const [row] = await db.select().from(events);

      expect(row!.at.toString()).toBe(at.toString());
      expect(row!.spans[0]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
        span.total({ unit: "microseconds", relativeTo: REL }),
      );
      expect(row!.spans[1]).toBeNull();

      await db.execute(sql`drop table if exists events_scoped2`);
    } finally {
      await pool.end();
    }
  });
});
