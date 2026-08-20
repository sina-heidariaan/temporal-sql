import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  parsePgRange,
  formatPgRange,
  decodePgRange,
  encodePgRange,
  splitPgMultirange,
  decodePgMultirange,
  encodePgMultirange,
  type TemporalRange,
} from "../src/range.js";
import {
  decodePlainDate,
  encodePlainDate,
  decodePlainDateTime,
  decodeInstant,
  encodeInstant,
  UnsupportedValueError,
  PrecisionError,
} from "../src/index.js";

describe("parsePgRange", () => {
  it("reads every inclusivity combination", () => {
    expect(parsePgRange("[a,b)")).toEqual({
      lower: "a",
      upper: "b",
      lowerInclusive: true,
      upperInclusive: false,
      empty: false,
    });
    expect(parsePgRange("(a,b]")).toMatchObject({ lowerInclusive: false, upperInclusive: true });
    expect(parsePgRange("[a,b]")).toMatchObject({ lowerInclusive: true, upperInclusive: true });
    expect(parsePgRange("(a,b)")).toMatchObject({ lowerInclusive: false, upperInclusive: false });
  });

  it("reads unbounded sides as null", () => {
    expect(parsePgRange("[a,)")).toMatchObject({ lower: "a", upper: null });
    expect(parsePgRange("(,b]")).toMatchObject({ lower: null, upper: "b" });
    expect(parsePgRange("(,)")).toMatchObject({ lower: null, upper: null, empty: false });
  });

  it("reads 'empty' (case-insensitively) as the empty range", () => {
    for (const text of ["empty", "EMPTY", "  empty "]) {
      expect(parsePgRange(text)).toEqual({
        lower: null,
        upper: null,
        lowerInclusive: false,
        upperInclusive: false,
        empty: true,
      });
    }
  });

  it("reads quoted bounds: commas, spaces, both escape styles", () => {
    expect(parsePgRange('["2024-01-01 00:00:00","2024-01-02 12:00:00")')).toMatchObject({
      lower: "2024-01-01 00:00:00",
      upper: "2024-01-02 12:00:00",
    });
    expect(parsePgRange('["a,b","c)d"]')).toMatchObject({ lower: "a,b", upper: "c)d" });
    // Backslash escape and SQL-style doubled quote both decode to a literal quote.
    expect(parsePgRange('["a\\"b",)')).toMatchObject({ lower: 'a"b' });
    expect(parsePgRange('["a""b",)')).toMatchObject({ lower: 'a"b' });
    // A quoted empty string is a bound whose text is empty — not unbounded.
    expect(parsePgRange('["",)')).toMatchObject({ lower: "" });
  });

  it("ignores unquoted whitespace around bounds, keeps interior whitespace", () => {
    expect(parsePgRange("[ a , b )")).toMatchObject({ lower: "a", upper: "b" });
    expect(parsePgRange('[ "a" , "b" )')).toMatchObject({ lower: "a", upper: "b" });
    expect(parsePgRange("[a b,c)")).toMatchObject({ lower: "a b" });
  });

  it("throws on malformed literals", () => {
    for (const bad of ["", "a,b", "[a,b", "a,b)", "[a b)", '["a,b)', "[a,b)x", "{a,b}"]) {
      expect(() => parsePgRange(bad), bad).toThrow(UnsupportedValueError);
    }
    expect(() => parsePgRange(null as unknown as string)).toThrow(/driver has already parsed/);
  });
});

describe("formatPgRange / encodePgRange", () => {
  it("formats empty, unbounded and quoted bounds", () => {
    expect(formatPgRange({ lower: null, upper: null, lowerInclusive: false, upperInclusive: false, empty: true })).toBe(
      "empty",
    );
    expect(formatPgRange({ lower: "a", upper: null, lowerInclusive: true, upperInclusive: false, empty: false })).toBe(
      '["a",)',
    );
    expect(
      formatPgRange({ lower: 'a"b', upper: "c\\d", lowerInclusive: false, upperInclusive: true, empty: false }),
    ).toBe('("a\\"b","c\\\\d"]');
  });

  it("round-trips through parsePgRange", () => {
    const cases = [
      { lower: "2024-01-01 00:00:00", upper: "2024-01-02 00:00:00", lowerInclusive: true, upperInclusive: false, empty: false },
      { lower: null, upper: "b,]", lowerInclusive: false, upperInclusive: true, empty: false },
      { lower: null, upper: null, lowerInclusive: false, upperInclusive: false, empty: true },
    ];
    for (const range of cases) expect(parsePgRange(formatPgRange(range))).toEqual(range);
  });

  it("encodePgRange runs bounds through the scalar encoder and propagates its errors", () => {
    const range: TemporalRange<Temporal.PlainDate> = {
      lower: Temporal.PlainDate.from("2024-01-01"),
      upper: Temporal.PlainDate.from("2024-01-05"),
      lowerInclusive: true,
      upperInclusive: false,
      empty: false,
    };
    expect(encodePgRange(range, encodePlainDate)).toBe('["2024-01-01","2024-01-05")');

    const subMicro: TemporalRange<Temporal.Instant> = {
      lower: Temporal.Instant.from("2024-01-01T00:00:00.000000123Z"),
      upper: null,
      lowerInclusive: true,
      upperInclusive: false,
      empty: false,
    };
    expect(() => encodePgRange(subMicro, (v) => encodeInstant(v))).toThrow(PrecisionError);
  });
});

describe("decodePgRange with the scalar codecs", () => {
  it("daterange → TemporalRange<PlainDate>", () => {
    const r = decodePgRange("[2024-01-01,2024-01-05)", decodePlainDate);
    expect(r.lower!.toString()).toBe("2024-01-01");
    expect(r.upper!.toString()).toBe("2024-01-05");
    expect(r.lowerInclusive).toBe(true);
    expect(r.upperInclusive).toBe(false);
  });

  it("tsrange → TemporalRange<PlainDateTime> (quoted bounds with spaces)", () => {
    const r = decodePgRange('["2024-01-01 00:00:00","2024-01-02 12:30:00.123456")', decodePlainDateTime);
    expect(r.lower!.toString()).toBe("2024-01-01T00:00:00");
    expect(r.upper!.toString()).toBe("2024-01-02T12:30:00.123456");
  });

  it("tstzrange → TemporalRange<Instant>, unbounded upper", () => {
    const r = decodePgRange('["2024-01-01 00:00:00+00",)', decodeInstant);
    expect(r.lower!.toString()).toBe("2024-01-01T00:00:00Z");
    expect(r.upper).toBeNull();
  });
});

describe("multiranges", () => {
  it("splits '{}' to [] and single/multiple ranges to their literals", () => {
    expect(splitPgMultirange("{}")).toEqual([]);
    expect(splitPgMultirange("{[a,b)}")).toEqual(["[a,b)"]);
    expect(splitPgMultirange("{[a,b),(c,d]}")).toEqual(["[a,b)", "(c,d]"]);
  });

  it("does not split on commas or brackets inside range bounds", () => {
    expect(splitPgMultirange('{["a,b","c)d"),[e,f]}')).toEqual(['["a,b","c)d")', "[e,f]"]);
    expect(splitPgMultirange('{["x""y",z)}')).toEqual(['["x""y",z)']);
  });

  it("decodes a multirange with disjoint ranges through the scalar codec", () => {
    const ranges = decodePgMultirange("{[2024-01-01,2024-01-05),[2024-02-01,2024-02-03)}", decodePlainDate);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.lower!.toString()).toBe("2024-01-01");
    expect(ranges[1]!.upper!.toString()).toBe("2024-02-03");
  });

  it("encodes an array of ranges as a brace literal", () => {
    const range: TemporalRange<Temporal.PlainDate> = {
      lower: Temporal.PlainDate.from("2024-01-01"),
      upper: Temporal.PlainDate.from("2024-01-05"),
      lowerInclusive: true,
      upperInclusive: false,
      empty: false,
    };
    expect(encodePgMultirange([range], encodePlainDate)).toBe('{["2024-01-01","2024-01-05")}');
    expect(encodePgMultirange([], encodePlainDate)).toBe("{}");
  });

  it("throws on malformed multirange text", () => {
    for (const bad of ["", "[a,b)", "{[a,b)", "{[a,b) [c,d)}", "{a}"]) {
      expect(() => splitPgMultirange(bad), bad).toThrow(UnsupportedValueError);
    }
  });
});
