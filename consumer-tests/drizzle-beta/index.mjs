/**
 * Drizzle 1.x (beta) consumer smoke test — runs against the packed tarball with
 * `drizzle-orm@beta` installed, i.e. the 1.0 line with the new codec layer.
 *
 * Drizzle 1.0 keeps `customType` and layers codecs on top (they are separate,
 * composable stages), so the columns from `temporal-sql/drizzle` must keep
 * building, mapping, and inferring exactly as they do on 0.x. This fixture is
 * the executable form of that claim.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pgTable } from "drizzle-orm/pg-core";
import * as t from "temporal-sql/drizzle";
import { decodeDuration } from "temporal-sql";

// Prove we are actually on the 1.x line, not a fallback resolution. drizzle-orm
// does not export ./package.json, so resolve the entry file and walk up to it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
let dir = dirname(require.resolve("drizzle-orm"));
let drizzleVersion = "unknown";
for (let depth = 0; depth < 6; depth++) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.name === "drizzle-orm") {
      drizzleVersion = pkg.version;
      break;
    }
  } catch {}
  dir = dirname(dir);
}
assert.ok(
  drizzleVersion.startsWith("1."),
  `expected drizzle-orm 1.x, got ${drizzleVersion} — the beta peer set is misconfigured`,
);

// Both call forms build named columns.
const events = pgTable("events", {
  at: t.timestamptz("at"),
  span: t.interval({ onSubMicrosecond: "truncate" })("span"),
  spans: t.intervalArray("spans"),
  day: t.date("day"),
});

assert.equal(events.at.getSQLType(), "timestamptz");
assert.equal(events.span.getSQLType(), "interval");
assert.equal(events.spans.getSQLType(), "interval[]");
assert.equal(events.day.getSQLType(), "date");

// customType mapping still runs through our codecs in both directions.
const inst = events.at.mapFromDriverValue("2024-01-01 12:00:00+00");
assert.equal(inst.toString(), "2024-01-01T12:00:00Z");
assert.equal(events.at.mapToDriverValue(inst), "2024-01-01T12:00:00.000000Z");

const spans = events.spans.mapFromDriverValue('{"1 day",NULL}');
assert.equal(spans[0].days, 1);
assert.equal(spans[1], null);
assert.equal(events.spans.mapToDriverValue([decodeDuration("1 day"), null]), '{"P1D",NULL}');

console.log(`drizzle-beta consumer OK (drizzle-orm ${drizzleVersion})`);
