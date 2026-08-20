import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { OID } from "../src/oids.js";

/** Every OID the adapters must cover: six scalars, six arrays, three ranges, three multiranges. */
const ALL_OIDS = [
  OID.timestamptz,
  OID.timestamp,
  OID.date,
  OID.time,
  OID.timetz,
  OID.interval,
  OID.timestamptzArray,
  OID.timestampArray,
  OID.dateArray,
  OID.timeArray,
  OID.timetzArray,
  OID.intervalArray,
  OID.daterange,
  OID.tsrange,
  OID.tstzrange,
  OID.datemultirange,
  OID.tsmultirange,
  OID.tstzmultirange,
].sort((a, b) => a - b);

describe("pg adapter", () => {
  it("registerTypeParsers sets a decoder per OID, scalars and arrays", async () => {
    const { registerTypeParsers } = await import("../src/pg.js");
    const seen = new Map<number, (v: string) => unknown>();
    registerTypeParsers({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(ALL_OIDS);
    const inst = seen.get(OID.timestamptz)!("2024-01-01 12:00:00+00") as Temporal.Instant;
    expect(inst.toString()).toBe("2024-01-01T12:00:00Z");
  });

  it("the array decoders decode each element, keeping NULL", async () => {
    const { registerTypeParsers } = await import("../src/pg.js");
    const seen = new Map<number, (v: string) => unknown>();
    registerTypeParsers({ setTypeParser: (oid, fn) => seen.set(oid, fn) });

    const instants = seen.get(OID.timestamptzArray)!(
      '{"2024-01-01 12:00:00+00",NULL}',
    ) as (Temporal.Instant | null)[];
    expect(instants[0]!.toString()).toBe("2024-01-01T12:00:00Z");
    expect(instants[1]).toBeNull();

    const durations = seen.get(OID.intervalArray)!('{"1 day","2 mons"}') as Temporal.Duration[];
    expect(durations.map((d) => d.toString())).toEqual(["P1D", "P2M"]);

    expect(seen.get(OID.dateArray)!("{}")).toEqual([]);
  });

  it("registerPassthrough returns raw text, for arrays too", async () => {
    const { registerPassthrough } = await import("../src/pg.js");
    const seen = new Map<number, (v: string) => unknown>();
    registerPassthrough({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(ALL_OIDS);
    expect(seen.get(OID.interval)!("raw")).toBe("raw");
    expect(seen.get(OID.intervalArray)!('{"1 day"}')).toBe('{"1 day"}');
  });

  it("encode helpers produce SQL text", async () => {
    const { encode } = await import("../src/pg.js");
    expect(encode.instant(Temporal.Instant.from("2024-01-01T00:00:00Z"))).toBe("2024-01-01T00:00:00.000000Z");
  });

  it("encode.*Array produce array literals, including NULL and empty", async () => {
    const { encode } = await import("../src/pg.js");
    expect(encode.instantArray([Temporal.Instant.from("2024-01-01T00:00:00Z"), null])).toBe(
      '{"2024-01-01T00:00:00.000000Z",NULL}',
    );
    expect(encode.durationArray([Temporal.Duration.from("P1D")])).toBe('{"P1D"}');
    expect(encode.plainDateArray([])).toBe("{}");
    expect(
      encode.zonedDateTimeArray([
        Temporal.Instant.from("2024-01-01T00:00:00Z").toZonedDateTimeISO("Europe/Berlin"),
      ]),
    ).toBe('{"2024-01-01T00:00:00.000000Z"}');
  });

  it("every mapped OID has both a decoder and a writer, with no gaps", async () => {
    const { encode } = await import("../src/pg.js");
    // Guards against adding an OID to the decode list but forgetting its writer.
    const writers = [
      "instantArray",
      "plainDateTimeArray",
      "plainDateArray",
      "plainTimeArray",
      "timetzArray",
      "durationArray",
      "plainDateRange",
      "plainDateTimeRange",
      "instantRange",
      "plainDateMultirange",
      "plainDateTimeMultirange",
      "instantMultirange",
    ] as const;
    for (const name of writers) expect(typeof encode[name], name).toBe("function");
    expect(ALL_OIDS).toHaveLength(18);
  });
});

describe("pg per-pool types (makePgTypes)", () => {
  it("decodes the OIDs it owns and delegates the rest to pg", async () => {
    const { makePgTypes } = await import("../src/pg.js");
    const types = makePgTypes();

    const instant = types.getTypeParser(OID.timestamptz)("2024-01-01 12:00:00+00") as Temporal.Instant;
    expect(instant.toString()).toBe("2024-01-01T12:00:00Z");

    const durations = types.getTypeParser(OID.intervalArray)('{"1 day"}') as Temporal.Duration[];
    expect(durations[0]!.days).toBe(1);

    // OID 23 is int4 — not ours, so pg's own parser must still be used.
    expect(types.getTypeParser(23)("42")).toBe(42);
  });

  it("passthrough mode hands back raw text for the OIDs it owns", async () => {
    const { makePgTypes } = await import("../src/pg.js");
    const types = makePgTypes({ mode: "passthrough" });
    expect(types.getTypeParser(OID.interval)("1 day")).toBe("1 day");
    expect(types.getTypeParser(OID.timestamptzArray)("{x}")).toBe("{x}");
    expect(types.getTypeParser(23)("42")).toBe(42);
  });

  it("leaves binary-format results to pg", async () => {
    const { makePgTypes } = await import("../src/pg.js");
    const types = makePgTypes();
    // Our codecs read text. A binary field must not be routed through them.
    expect(types.getTypeParser(OID.timestamptz, "binary")).not.toBe(
      types.getTypeParser(OID.timestamptz, "text"),
    );
  });
});

describe("postgres-js adapter", () => {
  it("exposes {to, from, serialize, parse} per type", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    expect(temporalTypes.instant.to).toBe(OID.timestamptz);
    expect(temporalTypes.duration.from).toEqual([OID.interval]);
    expect(temporalTypes.instant.parse("2024-01-01 00:00:00+00")).toBeDefined();
    expect(temporalTypes.duration.serialize(Temporal.Duration.from({ days: 1 }))).toBe("P1D");
  });

  it("registers the six array types on their own OIDs", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    const pairs: Array<[{ to: number; from: number[] }, number]> = [
      [temporalTypes.instantArray, OID.timestamptzArray],
      [temporalTypes.plainDateTimeArray, OID.timestampArray],
      [temporalTypes.plainDateArray, OID.dateArray],
      [temporalTypes.plainTimeArray, OID.timeArray],
      [temporalTypes.timetzArray, OID.timetzArray],
      [temporalTypes.durationArray, OID.intervalArray],
    ];
    for (const [type, oid] of pairs) {
      expect(type.to).toBe(oid);
      expect(type.from).toEqual([oid]);
    }
  });

  it("array types serialize and parse through the scalar codecs", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    expect(temporalTypes.durationArray.serialize([Temporal.Duration.from({ days: 1 }), null])).toBe(
      '{"P1D",NULL}',
    );
    const parsed = temporalTypes.durationArray.parse('{"1 day",NULL}') as (Temporal.Duration | null)[];
    expect(parsed[0]!.days).toBe(1);
    expect(parsed[1]).toBeNull();
  });

  it("registers the three range and three multirange types on their own OIDs", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    const pairs: Array<[{ to: number; from: number[] }, number]> = [
      [temporalTypes.plainDateRange, OID.daterange],
      [temporalTypes.plainDateTimeRange, OID.tsrange],
      [temporalTypes.instantRange, OID.tstzrange],
      [temporalTypes.plainDateMultirange, OID.datemultirange],
      [temporalTypes.plainDateTimeMultirange, OID.tsmultirange],
      [temporalTypes.instantMultirange, OID.tstzmultirange],
    ];
    for (const [type, oid] of pairs) {
      expect(type.to).toBe(oid);
      expect(type.from).toEqual([oid]);
    }
  });

  it("range types serialize and parse through the scalar codecs", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    const parsed = temporalTypes.plainDateRange.parse("[2024-01-01,2024-01-05)") as {
      lower: Temporal.PlainDate;
      upper: Temporal.PlainDate;
      lowerInclusive: boolean;
      upperInclusive: boolean;
      empty: boolean;
    };
    expect(parsed.lower.toString()).toBe("2024-01-01");
    expect(parsed.upper.toString()).toBe("2024-01-05");
    expect(parsed.lowerInclusive).toBe(true);
    expect(parsed.upperInclusive).toBe(false);
    expect(parsed.empty).toBe(false);

    expect(
      temporalTypes.plainDateRange.serialize({
        lower: Temporal.PlainDate.from("2024-01-01"),
        upper: null,
        lowerInclusive: true,
        upperInclusive: false,
        empty: false,
      }),
    ).toBe('["2024-01-01",)');

    const multi = temporalTypes.instantMultirange.parse(
      '{["2024-01-01 00:00:00+00","2024-01-02 00:00:00+00"),["2024-02-01 00:00:00+00","2024-02-03 00:00:00+00")}',
    ) as Array<{ lower: Temporal.Instant }>;
    expect(multi).toHaveLength(2);
    expect(multi[0]!.lower.toString()).toBe("2024-01-01T00:00:00Z");
  });
});

describe("drizzle adapter", () => {
  it("factories return callable column builders", async () => {
    const t = await import("../src/drizzle.js");
    // Each factory returns a drizzle customType builder (a function).
    expect(typeof t.timestamptz()).toBe("function");
    expect(typeof t.interval()).toBe("function");
    // Building a named column should not throw.
    expect(() => t.timestamptz()("created_at")).not.toThrow();
  });

  it("single-call form builds the same column as the two-call form", async () => {
    const t = await import("../src/drizzle.js");
    const { pgTable } = await import("drizzle-orm/pg-core");
    const table = pgTable("t1", {
      at: t.timestamptz("at"),
      span: t.interval("span", { onSubMicrosecond: "truncate" }),
      day: t.date("day"),
      spans: t.intervalArray("spans"),
    });
    expect(table.at.getSQLType()).toBe("timestamptz");
    expect(table.span.getSQLType()).toBe("interval");
    expect(table.day.getSQLType()).toBe("date");
    expect(table.spans.getSQLType()).toBe("interval[]");
    // The EncodeOptions passed in the single call reach the encoder.
    const subMicro = Temporal.Duration.from({ nanoseconds: 1500 });
    expect(table.span.mapToDriverValue(subMicro)).toBe("PT0.000001S");
    // Decode still flows through the codec.
    const inst = table.at.mapFromDriverValue("2024-01-01 12:00:00+00") as Temporal.Instant;
    expect(inst.toString()).toBe("2024-01-01T12:00:00Z");
  });

  it("array factories build columns with the right SQL type", async () => {
    const t = await import("../src/drizzle.js");
    const { pgTable } = await import("drizzle-orm/pg-core");
    const table = pgTable("t", {
      at: t.timestamptzArray()("at"),
      spans: t.intervalArray()("spans"),
      days: t.dateArray()("days"),
      stamps: t.timestampArray()("stamps"),
      times: t.timeArray()("times"),
      zoned: t.timetzArray()("zoned"),
    });
    expect(table.at.getSQLType()).toBe("timestamptz[]");
    expect(table.spans.getSQLType()).toBe("interval[]");
    expect(table.days.getSQLType()).toBe("date[]");
    expect(table.stamps.getSQLType()).toBe("timestamp[]");
    expect(table.times.getSQLType()).toBe("time[]");
    expect(table.zoned.getSQLType()).toBe("timetz[]");
  });

  it("array columns map both directions", async () => {
    const t = await import("../src/drizzle.js");
    const { pgTable } = await import("drizzle-orm/pg-core");
    const table = pgTable("t2", { spans: t.intervalArray()("spans") });

    expect(table.spans.mapToDriverValue([Temporal.Duration.from("P1D"), null])).toBe('{"P1D",NULL}');
    const back = table.spans.mapFromDriverValue('{"1 day",NULL}') as (Temporal.Duration | null)[];
    expect(back[0]!.days).toBe(1);
    expect(back[1]).toBeNull();
  });
});

describe("prisma adapter", () => {
  it("decodeRow maps named string fields to Temporal", async () => {
    const { decodeRow } = await import("../src/prisma.js");
    const row = { id: 1, created_at: "2024-01-01 00:00:00+00", span: "P1D", note: null };
    const out = decodeRow<{ id: number; created_at: Temporal.Instant; span: Temporal.Duration; note: null }>(row, {
      created_at: "instant",
      span: "duration",
    });
    expect(out.id).toBe(1);
    expect(out.note).toBeNull();
    expect(out.created_at.toString()).toBe("2024-01-01T00:00:00Z");
    expect(out.span.days).toBe(1);
  });

  it("decodeRow maps array columns too", async () => {
    const { decodeRow } = await import("../src/prisma.js");
    const row = { spans: '{"1 day",NULL}' };
    const out = decodeRow<{ spans: (Temporal.Duration | null)[] }>(row, { spans: "durationArray" });
    expect(out.spans[0]!.days).toBe(1);
    expect(out.spans[1]).toBeNull();
  });
});
