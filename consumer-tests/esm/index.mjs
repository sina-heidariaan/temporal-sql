/**
 * ESM consumer smoke test — runs against the packed tarball, not the repo.
 *
 * Proves that a real `import` of the root and the adapter subpaths resolves and
 * executes. Anything this file can do, a consumer can do.
 */
import assert from "node:assert/strict";
import { decodeDuration, encodeDuration, decodeInstant, UnsupportedValueError } from "temporal-sql";
import { registerTypeParsers, registerPassthrough, encode } from "temporal-sql/pg";
import { temporalTypes } from "temporal-sql/postgres-js";
import { interval as drizzleInterval } from "temporal-sql/drizzle";
import { assertTemporalSqlSession, configureTemporalSqlSession } from "temporal-sql/session";

// Root export: execute a codec end to end.
const d = decodeDuration("1 year 2 mons 3 days 04:05:06");
assert.equal(d.years, 1);
assert.equal(d.months, 2);
assert.equal(d.days, 3);
assert.equal(d.hours, 4);
assert.equal(encodeDuration(d), "P1Y2M3DT4H5M6S");

const i = decodeInstant("2024-01-01 12:00:00+00");
assert.equal(i.epochMilliseconds, Date.UTC(2024, 0, 1, 12));

// The v0.1.1 strictness contract must hold through the packed build.
assert.throws(() => decodeDuration("nonsense"), UnsupportedValueError);
assert.throws(() => decodeDuration("1 day trailing"), UnsupportedValueError);

// Adapter subpaths: importing them must not throw, and their shape must survive.
assert.equal(typeof registerTypeParsers, "function");
assert.equal(typeof registerPassthrough, "function");
assert.equal(typeof encode.duration, "function");
assert.equal(temporalTypes.duration.parse("3 days").days, 3);
assert.equal(typeof drizzleInterval, "function");

// sql_standard is decodable from the root export (v0.2.0).
assert.equal(decodeDuration("+1-2 +3 +4:05:06").months, 2);
assert.equal(decodeDuration("0").toString(), "PT0S");

// Session subpath: assert against a fake query function.
const fakeQuery = async (t) =>
  /DateStyle/i.test(t)
    ? { rows: [{ DateStyle: "ISO, MDY" }] }
    : /IntervalStyle/i.test(t)
      ? { rows: [{ IntervalStyle: "iso_8601" }] }
      : { rows: [{ TimeZone: "UTC" }] };
const diag = await assertTemporalSqlSession(fakeQuery);
assert.equal(diag.intervalStyle, "iso_8601");
assert.equal(typeof configureTemporalSqlSession, "function");

console.log("esm consumer OK");
