/**
 * ESM consumer smoke test — runs against the packed tarball, not the repo.
 *
 * Proves that a real `import` of the root and the adapter subpaths resolves and
 * executes. Anything this file can do, a consumer can do.
 */
import assert from "node:assert/strict";
import {
  decodeDuration,
  encodeDuration,
  decodeInstant,
  parsePgArray,
  formatPgArray,
  decodePgArray,
  UnsupportedValueError,
} from "temporal-sql";
import { registerTypeParsers, registerPassthrough, encode, makePgTypes } from "temporal-sql/pg";
import { temporalTypes } from "temporal-sql/postgres-js";
import { interval as drizzleInterval, intervalArray as drizzleIntervalArray } from "temporal-sql/drizzle";
import { assertTemporalSqlSession, configureTemporalSqlSession } from "temporal-sql/session";
import { runDoctor, renderDoctorText, renderDoctorMarkdown } from "temporal-sql/doctor";
import { decodePgRange, encodePgRange, decodePgMultirange, decodePlainDate, encodePlainDate } from "temporal-sql";

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
const scopedTypes = makePgTypes();
assert.equal(scopedTypes.getTypeParser(1186)("3 days").days, 3);
assert.equal(makePgTypes({ mode: "passthrough" }).getTypeParser(1186)("3 days"), "3 days");

// A non-string reaching the parser names the fix instead of "malformed literal".
assert.throws(() => parsePgArray([new Date()]), /registerPassthrough/);

// Ranges & multiranges (v0.4.0): grammar, codecs, and pg encode helpers.
const range = decodePgRange("[2024-01-01,2024-01-05)", decodePlainDate);
assert.equal(range.lower.toString(), "2024-01-01");
assert.equal(range.lowerInclusive, true);
assert.equal(range.upperInclusive, false);
assert.equal(encodePgRange(range, encodePlainDate), '["2024-01-01","2024-01-05")');
assert.equal(decodePgRange("empty", decodePlainDate).empty, true);
const multi = decodePgMultirange("{[2024-01-01,2024-01-05),[2024-02-01,2024-02-03)}", decodePlainDate);
assert.equal(multi.length, 2);
assert.equal(typeof encode.instantRange, "function");
assert.equal(typeof encode.plainDateMultirange, "function");
assert.equal(temporalTypes.plainDateRange.parse("[2024-01-01,2024-01-05)").upper.toString(), "2024-01-05");

// Doctor (v0.4.0): the engine and renderers resolve and run.
const doctorReport = await runDoctor(async () => {
  throw new Error("no database in this fixture");
});
assert.equal(doctorReport.ok, false);
assert.equal(doctorReport.checks[0].id, "connectivity");
assert.ok(renderDoctorText(doctorReport).includes("temporal-sql doctor"));
assert.ok(renderDoctorMarkdown(doctorReport).startsWith("#"));

// Registration is reversible. 18 OIDs: 6 scalars + 6 arrays + 3 ranges + 3 multiranges.
const seen = new Map();
const restore = registerPassthrough({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
assert.equal(seen.size, 18);
assert.equal(typeof restore, "function");
restore();

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
