/**
 * drizzle-zod consumer test — the executable reproduction of
 * https://github.com/drizzle-team/drizzle-orm/issues/5692 and of the pattern
 * this package documents for it (docs/migrations/drizzle.md).
 *
 * The issue: `createInsertSchema` / `createSelectSchema` cannot know what a
 * `customType` column holds, so a Temporal column gets no validation unless the
 * caller overrides it — per schema call, per column. This fixture pins both
 * halves: (1) the default schema really does accept garbage for a Temporal
 * column, and (2) the one-line override restores real validation.
 */
import assert from "node:assert/strict";
import { pgTable } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import * as t from "temporal-sql/drizzle";
import { decodeInstant } from "temporal-sql";

const events = pgTable("events", {
  at: t.timestamptz("at"),
});

const instant = decodeInstant("2024-01-01 12:00:00+00");

// (1) The reproduction: with no override, a custom column is unvalidated —
// a number sails through where a Temporal.Instant belongs.
const unvalidated = createInsertSchema(events);
assert.equal(unvalidated.safeParse({ at: 42 }).success, true, "expected the un-overridden schema to accept anything (drizzle-orm#5692)");

// (2) The documented pattern: one reusable zod schema per Temporal type,
// passed as an override wherever the column appears.
const zInstant = z.custom((v) => typeof v?.epochNanoseconds === "bigint", {
  message: "expected a Temporal.Instant",
});
const validated = createInsertSchema(events, { at: zInstant });
assert.equal(validated.safeParse({ at: instant }).success, true);
assert.equal(validated.safeParse({ at: 42 }).success, false);
assert.equal(validated.safeParse({ at: "2024-01-01" }).success, false);

console.log("drizzle-zod consumer OK — #5692 reproduced and the override pattern validated");
