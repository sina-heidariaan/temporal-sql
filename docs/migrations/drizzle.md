# Drizzle ORM: Date → Temporal

Drizzle's built-in `timestamp()`/`date()` columns are typed as JS `Date` (or
strings in `mode: "string"`). Swap them for the Temporal column factories.

## Before

```ts
import { pgTable, timestamp, interval } from "drizzle-orm/pg-core";

export const events = pgTable("events", {
  at: timestamp("at", { withTimezone: true }),  // Date — µs gone, zone games
  span: interval("span"),                        // string
});
```

## Step 1 — verify, then register passthrough

```bash
npx temporal-sql doctor --url $DATABASE_URL
```

```ts
import { registerPassthrough } from "temporal-sql/pg";
registerPassthrough(); // REQUIRED, once at startup
```

Why: Drizzle's custom columns decode from **raw text**, but `pg` converts
date/time columns to `Date` first unless told not to. `registerPassthrough()`
is that switch. (`makePgTypes()` cannot replace it — Drizzle attaches its own
`types` to every query and falls back to pg's *global* table.)

## Step 2 — swap the columns

```ts
import { pgTable } from "drizzle-orm/pg-core";
import * as t from "temporal-sql/drizzle";

export const events = pgTable("events", {
  at:    t.timestamptz("at"),                                  // Temporal.Instant
  local: t.timestamp("local"),                                 // Temporal.PlainDateTime
  day:   t.date("day"),                                        // Temporal.PlainDate
  span:  t.interval("span", { onSubMicrosecond: "truncate" }), // Temporal.Duration
  spans: t.intervalArray("spans"),                             // (Duration | null)[]
});
```

The generated SQL types are identical (`timestamptz`, `interval`, …), so **no
database migration is needed** — this changes only the TypeScript/runtime
mapping. `drizzle-kit` sees the same `dataType` strings.

Selects and inserts now speak Temporal end to end:

```ts
const rows = await db.select().from(events);
rows[0].at;                       // Temporal.Instant
await db.insert(events).values({ at: Temporal.Now.instant() });
```

## drizzle-zod

`createInsertSchema` / `createSelectSchema` cannot know what a custom column
holds, so a Temporal column gets **no validation** by default — that is
[drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692), and it
means `createInsertSchema(events).parse({ at: 42 })` succeeds silently.

The pattern until Drizzle grows a hook: define one zod schema per Temporal type
and pass it as an override wherever the column appears.

```ts
import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";

export const zInstant = z.custom<Temporal.Instant>(
  (v) => typeof (v as Temporal.Instant)?.epochNanoseconds === "bigint",
  { message: "expected a Temporal.Instant" },
);

const insertEvent = createInsertSchema(events, { at: zInstant });
insertEvent.parse({ at: Temporal.Now.instant() }); // ok
insertEvent.parse({ at: 42 });                     // throws — validated again
```

This exact behavior (the silent default *and* the override) is executed in this
repo's CI: `consumer-tests/drizzle-zod/`.

## Drizzle 1.x

The columns work unchanged on the drizzle-orm 1.0 (beta) line — `customType`
remains, and the new codec layer composes with it rather than replacing it.
CI runs the packed package against `drizzle-orm@beta` on every push
(`consumer-tests/drizzle-beta/`).

## Pitfalls

- Forgetting `registerPassthrough()` is the #1 failure: columns then receive a
  `Date` instead of text. The error message names the fix.
- A pool with no `types` shares pg's global table, so after
  `registerPassthrough()` your *non-Drizzle* pools return raw strings — give
  those pools `makePgTypes()`. See "Using both together" in the README.
- Range columns have no Drizzle factory yet; read them via
  `customType` + `decodePgRange`, or raw SQL.
