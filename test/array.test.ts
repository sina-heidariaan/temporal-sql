/**
 * The vendored Postgres array grammar.
 *
 * These cases are the reason the parser exists: splitting on commas gets every
 * one of them wrong. The expectations are the Postgres grammar itself, checked
 * here without a database; `test/integration/roundtrip.test.ts` then proves the
 * same behaviour against real `array_out` text.
 */
import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  parsePgArray,
  formatPgArray,
  decodePgArray,
  encodePgArray,
  decodeDuration,
  encodeDuration,
  UnsupportedValueError,
  PrecisionError,
  type PgArrayElement,
} from "../src/index.js";

describe("parsePgArray", () => {
  it.each<[label: string, input: string, expected: PgArrayElement[]]>([
    ["empty array", "{}", []],
    ["bare elements", "{a,b}", ["a", "b"]],
    ["quoted elements", '{"a","b"}', ["a", "b"]],
    ["unquoted NULL is SQL NULL", "{NULL}", [null]],
    ['quoted "NULL" is text', '{"NULL"}', ["NULL"]],
    ["lower-case null is SQL NULL", "{null}", [null]],
    ["NULL among values", '{"1 day",NULL,"2 days"}', ["1 day", null, "2 days"]],
    ["comma inside quotes is data", '{"a,b"}', ["a,b"]],
    ["braces inside quotes are data", '{"{x}"}', ["{x}"]],
    ["escaped quote", '{"a\\"b"}', ['a"b']],
    ["escaped backslash", '{"a\\\\b"}', ["a\\b"]],
    ["empty string element", '{""}', [""]],
    ["spaces inside quotes survive", '{"1 year 2 mons"}', ["1 year 2 mons"]],
    ["nested arrays", "{{1,2},{3,4}}", [["1", "2"], ["3", "4"]]],
    ["ragged nesting is still parsed", "{{a},{b,c}}", [["a"], ["b", "c"]]],
    ["dimension prefix is consumed", "[0:2]={a,b,c}", ["a", "b", "c"]],
    ["multi-axis dimension prefix", "[1:2][1:2]={{1,2},{3,4}}", [["1", "2"], ["3", "4"]]],
    ["whitespace between elements", "{ a , b }", ["a", "b"]],
    ["whitespace-only braces are the empty array", "{  }", []],
    ["empty nested array", "{{}}", [[]]],
    ["three levels of nesting", "{{{a}}}", [[["a"]]]],
    ["nesting with NULL leaves", "{{a,NULL},{NULL,b}}", [["a", null], [null, "b"]]],
    ["unicode content", '{"héllo — wörld","日本語"}', ["héllo — wörld", "日本語"]],
    ["newline and tab inside quotes", '{"a\nb\tc"}', ["a\nb\tc"]],
    ["a quoted brace-only element", '{"{"}', ["{"]],
    ["a quoted lone backslash", '{"\\\\"}', ["\\"]],
    ["escaped comma outside quotes", "{a\\,b}", ["a,b"]],
    ["escaped brace outside quotes", "{a\\}b}", ["a}b"]],
    ["leading and trailing whitespace around the literal", "  {a}  ", ["a"]],
    ["iso_8601 intervals need no quoting", "{P1Y2M,PT1H30M}", ["P1Y2M", "PT1H30M"]],
    ["sql_standard interval text", '{"+1-2 +3 +4:05:06"}', ["+1-2 +3 +4:05:06"]],
    ["postgres_verbose interval text", '{"@ 1 year 2 mons"}', ["@ 1 year 2 mons"]],
    ["bare date elements", "{2024-02-29,1969-07-20}", ["2024-02-29", "1969-07-20"]],
    ["timetz elements are unquoted", "{12:34:56.789012+05:30}", ["12:34:56.789012+05:30"]],
  ])("%s", (_label, input, expected) => {
    expect(parsePgArray(input)).toEqual(expected);
  });

  it("handles a large array without stack or perf trouble", () => {
    const items = Array.from({ length: 10_000 }, (_, n) => `e${n}`);
    const parsed = parsePgArray(formatPgArray(items));
    expect(parsed).toHaveLength(10_000);
    expect(parsed[0]).toBe("e0");
    expect(parsed[9_999]).toBe("e9999");
  });

  it.each<[label: string, input: string]>([
    ["unbalanced open brace", "{a"],
    ["unbalanced close brace", "a}"],
    ["missing braces entirely", "a,b"],
    ["unterminated quote", '{"a}'],
    ["trailing text after the array", "{a} junk"],
    ["empty element between commas", "{a,,b}"],
    ["trailing comma", "{a,}"],
    ["trailing backslash", "{a\\"],
    ["dimension prefix without '='", "[0:2]{a}"],
    ["the empty string", ""],
    ["whitespace only", "   "],
    ["a lone open brace", "{"],
    ["a lone close brace", "}"],
    ["unclosed nested array", "{{}"],
    ["extra close brace", "{a}}"],
    ["quote starting mid-element", '{a"b"}'],
    ["text between a quoted element and the separator", '{"a"b}'],
    ["leading comma", "{,a}"],
    ["two arrays side by side", "{a}{b}"],
    ["nested array followed by junk", "{{a}x}"],
  ])("throws on %s", (_label, input) => {
    expect(() => parsePgArray(input)).toThrow(UnsupportedValueError);
  });

  it("does not treat an escaped NULL as SQL NULL", () => {
    expect(parsePgArray("{\\NULL}")).toEqual(["NULL"]);
  });

  it("names the likely cause when the driver already parsed the column", () => {
    // The realistic failure: Drizzle without registerPassthrough(), so pg hands
    // over an array of Dates instead of text. A bare "expected '{'" would send
    // the reader hunting in the wrong place.
    for (const notText of [[new Date()], null, undefined, 42, { a: 1 }]) {
      expect(() => parsePgArray(notText as never)).toThrow(UnsupportedValueError);
      expect(() => parsePgArray(notText as never)).toThrow(/registerPassthrough/);
    }
  });
});

describe("formatPgArray", () => {
  it("writes the empty array", () => {
    expect(formatPgArray([])).toBe("{}");
  });

  it("quotes every element and writes NULL bare", () => {
    expect(formatPgArray(["a", null, "b"])).toBe('{"a",NULL,"b"}');
  });

  it("escapes quotes and backslashes", () => {
    expect(formatPgArray(['a"b', "a\\b"])).toBe('{"a\\"b","a\\\\b"}');
  });

  it("quotes the literal text NULL so it cannot be read back as SQL NULL", () => {
    expect(formatPgArray(["NULL"])).toBe('{"NULL"}');
    expect(parsePgArray(formatPgArray(["NULL"]))).toEqual(["NULL"]);
  });

  it("nests", () => {
    expect(formatPgArray([["1", "2"], ["3"]])).toBe('{{"1","2"},{"3"}}');
  });
});

describe("parse ∘ format round-trip", () => {
  // Wrapped in a 1-tuple: `it.each` spreads a bare array across parameters.
  it.each<[PgArrayElement[]]>([
    [[]],
    [["a"]],
    [["a", "b", "c"]],
    [[null]],
    [["a", null, ""]],
    [['he said "hi"', "back\\slash", "comma,inside", "{braces}"]],
    [["1 year 2 mons 3 days 04:05:06.789012", "-3 days -04:05:06"]],
    [[["1", "2"], ["3", null]]],
  ])("survives %j", (value) => {
    expect(parsePgArray(formatPgArray(value))).toEqual(value);
  });
});

describe("decodePgArray / encodePgArray", () => {
  it("runs each element through the scalar codec", () => {
    const out = decodePgArray('{"1 day","2 mons"}', decodeDuration);
    expect(out.map((d) => d?.toString())).toEqual(["P1D", "P2M"]);
  });

  it("keeps SQL NULL as null instead of calling the codec", () => {
    const out = decodePgArray('{"1 day",NULL}', decodeDuration);
    expect(out[0]!.days).toBe(1);
    expect(out[1]).toBeNull();
  });

  it("decodes the empty array to []", () => {
    expect(decodePgArray("{}", decodeDuration)).toEqual([]);
  });

  it("rejects a multidimensional array with a named error", () => {
    expect(() => decodePgArray("{{1},{2}}", decodeDuration)).toThrow(UnsupportedValueError);
    expect(() => decodePgArray("{{1},{2}}", decodeDuration)).toThrow(/[Mm]ultidimensional/);
  });

  it("encodes nulls and values together", () => {
    const text = encodePgArray([Temporal.Duration.from("P1D"), null], (d) => encodeDuration(d));
    expect(text).toBe('{"P1D",NULL}');
  });

  it("encodes the empty array", () => {
    expect(encodePgArray([], encodeDuration)).toBe("{}");
  });

  it("propagates a scalar encoder error rather than emitting a partial array", () => {
    const nanos = Temporal.Duration.from({ nanoseconds: 1 });
    expect(() => encodePgArray([nanos], (d) => encodeDuration(d))).toThrow(PrecisionError);
  });

  it("treats undefined like null on encode", () => {
    expect(encodePgArray([undefined, Temporal.Duration.from("P1D")], encodeDuration)).toBe('{NULL,"P1D"}');
  });

  it("propagates a decode error for a bad element", () => {
    expect(() => decodePgArray('{"1 day","nonsense"}', decodeDuration)).toThrow(UnsupportedValueError);
  });

  it("keeps element order across a large array", () => {
    const values = Array.from({ length: 500 }, (_, n) => Temporal.Duration.from({ days: n + 1 }));
    const text = encodePgArray(values, (d) => encodeDuration(d));
    const back = decodePgArray(text, decodeDuration);
    expect(back).toHaveLength(500);
    expect(back.map((d) => d!.days)).toEqual(values.map((d) => d.days));
  });
});

describe("ZonedDateTime arrays", () => {
  it("decode projects every element onto the given zone, keeping NULL", async () => {
    const { decodeZonedDateTimeArray, encodeZonedDateTimeArray } = await import("../src/index.js");
    const out = decodeZonedDateTimeArray('{"2024-03-10 07:30:45.123456+00",NULL}', "Europe/Berlin");
    expect(out[0]!.timeZoneId).toBe("Europe/Berlin");
    expect(out[0]!.toInstant().toString()).toBe("2024-03-10T07:30:45.123456Z");
    expect(out[1]).toBeNull();

    // Encoding reduces each value to its instant, so the zone does not survive —
    // the same documented behaviour as the scalar encodeZonedDateTime.
    expect(encodeZonedDateTimeArray([out[0]!, null])).toBe('{"2024-03-10T07:30:45.123456Z",NULL}');
  });
});
