/**
 * CommonJS consumer smoke test — runs against the packed tarball, not the repo.
 *
 * This package is ESM-first; the `require` conditions point at the .cjs build.
 * A CJS consumer must be able to `require` the root and the adapter subpaths and
 * execute a codec.
 */
const assert = require("node:assert/strict");
const {
  decodeDuration,
  encodeDuration,
  decodeInstant,
  parsePgArray,
  formatPgArray,
  decodePgArray,
  UnsupportedValueError,
} = require("temporal-sql");
const { registerTypeParsers, registerPassthrough, encode, makePgTypes } = require("temporal-sql/pg");
const { temporalTypes } = require("temporal-sql/postgres-js");
const { interval: drizzleInterval, intervalArray: drizzleIntervalArray } = require("temporal-sql/drizzle");
const { assertTemporalSqlSession, configureTemporalSqlSession } = require("temporal-sql/session");

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

// Arrays (v0.3.0): the grammar, the codecs, and the adapter surface.
assert.deepEqual(parsePgArray('{"1 day",NULL,"a,b"}'), ["1 day", null, "a,b"]);
assert.equal(formatPgArray(["a", null]), '{"a",NULL}');
const spans = decodePgArray('{"1 day",NULL}', decodeDuration);
assert.equal(spans[0].days, 1);
assert.equal(spans[1], null);
assert.equal(encode.durationArray([d, null]), '{"P1Y2M3DT4H5M6S",NULL}');
assert.equal(temporalTypes.durationArray.parse('{"3 days"}')[0].days, 3);
assert.equal(typeof drizzleIntervalArray, "function");
assert.ok(drizzleIntervalArray()("spans"));

// makePgTypes scopes decoding to one pool instead of mutating pg globally.
assert.equal(makePgTypes().getTypeParser(1186)("3 days").days, 3);
assert.equal(makePgTypes({ mode: "passthrough" }).getTypeParser(1186)("3 days"), "3 days");

// A non-string reaching the parser names the fix instead of "malformed literal".
assert.throws(() => parsePgArray([new Date()]), /registerPassthrough/);

// Registration is reversible.
const seen = new Map();
const restore = registerPassthrough({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
assert.equal(seen.size, 12);
assert.equal(typeof restore, "function");
restore();

// Session subpath resolves and runs.
assert.equal(typeof assertTemporalSqlSession, "function");
assert.equal(typeof configureTemporalSqlSession, "function");
const fakeQuery = async (t) =>
  /DateStyle/i.test(t)
    ? { rows: [{ DateStyle: "ISO, MDY" }] }
    : /IntervalStyle/i.test(t)
      ? { rows: [{ IntervalStyle: "iso_8601" }] }
      : { rows: [{ TimeZone: "UTC" }] };
assertTemporalSqlSession(fakeQuery).then((diag) => {
  assert.equal(diag.intervalStyle, "iso_8601");
  console.log("commonjs consumer OK");
});
