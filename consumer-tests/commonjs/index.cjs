/**
 * CommonJS consumer smoke test — runs against the packed tarball, not the repo.
 *
 * This package is ESM-first; the `require` conditions point at the .cjs build.
 * A CJS consumer must be able to `require` the root and the adapter subpaths and
 * execute a codec.
 */
const assert = require("node:assert/strict");
const { decodeDuration, encodeDuration, decodeInstant, UnsupportedValueError } = require("temporal-sql");
const { registerTypeParsers, registerPassthrough, encode } = require("temporal-sql/pg");
const { temporalTypes } = require("temporal-sql/postgres-js");
const { interval: drizzleInterval } = require("temporal-sql/drizzle");

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

console.log("commonjs consumer OK");
