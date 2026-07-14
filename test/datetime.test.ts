import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  decodeInstant,
  encodeInstant,
  decodeZonedDateTime,
  encodeZonedDateTime,
} from "../src/timestamptz.js";
import { decodePlainDateTime, encodePlainDateTime } from "../src/timestamp.js";
import { decodePlainDate, encodePlainDate } from "../src/date.js";
import { decodePlainTime, encodePlainTime } from "../src/time.js";
import { decodeTimetz, decodeTimetzTime, encodeTimetz } from "../src/timetz.js";
import { PrecisionError, UnsupportedValueError } from "../src/shared.js";

describe("timestamptz ⇄ Instant", () => {
  it("decodes +00 offset", () => {
    expect(decodeInstant("2024-01-01 12:34:56.789+00").toString()).toBe("2024-01-01T12:34:56.789Z");
  });

  it("decodes +05:30 offset to the correct instant", () => {
    expect(decodeInstant("2024-01-01 18:04:56+05:30").toString()).toBe("2024-01-01T12:34:56Z");
  });

  it("decodes -08 offset", () => {
    expect(decodeInstant("2024-01-01 04:34:56-08").toString()).toBe("2024-01-01T12:34:56Z");
  });

  it("is lossless to microseconds", () => {
    expect(decodeInstant("2024-01-01 12:34:56.789012+00").toString()).toBe("2024-01-01T12:34:56.789012Z");
  });

  it("handles DST spring-forward boundary", () => {
    // 2024-03-10 07:00Z is the US spring-forward instant; offset-based decode is unambiguous.
    expect(decodeInstant("2024-03-10 07:00:00+00").toString()).toBe("2024-03-10T07:00:00Z");
  });

  it("encodes to ISO with Z and microsecond precision", () => {
    const i = Temporal.Instant.from("2024-01-01T12:34:56.789Z");
    expect(encodeInstant(i)).toBe("2024-01-01T12:34:56.789000Z");
  });

  it("rejects infinity", () => {
    expect(() => decodeInstant("infinity")).toThrow(UnsupportedValueError);
    expect(() => decodeInstant("-infinity")).toThrow(UnsupportedValueError);
  });

  it("ZonedDateTime projects onto the supplied zone", () => {
    const z = decodeZonedDateTime("2024-01-01 12:34:56+00", "America/New_York");
    expect(z.hour).toBe(7); // UTC-5 in January
    expect(encodeZonedDateTime(z)).toBe("2024-01-01T12:34:56.000000Z");
  });
});

describe("timestamp ⇄ PlainDateTime", () => {
  it("round-trips a wall-clock value", () => {
    const dt = decodePlainDateTime("2024-01-01 12:34:56.789012");
    expect(dt.toString()).toBe("2024-01-01T12:34:56.789012");
    expect(encodePlainDateTime(dt)).toBe("2024-01-01 12:34:56.789012");
  });

  it("rejects BC", () => {
    expect(() => decodePlainDateTime("0044-03-15 12:00:00 BC")).toThrow(UnsupportedValueError);
  });
});

describe("date ⇄ PlainDate", () => {
  it("round-trips a modern date", () => {
    expect(encodePlainDate(decodePlainDate("2024-02-29"))).toBe("2024-02-29");
  });

  it("handles pre-1970 dates", () => {
    expect(decodePlainDate("1969-07-20").toString()).toBe("1969-07-20");
  });

  it("maps 44 BC to proleptic year -43 and back", () => {
    const d = decodePlainDate("0044-03-15 BC");
    expect(d.year).toBe(-43);
    expect(encodePlainDate(d)).toBe("0044-03-15 BC");
  });

  it("handles years ≥ 10000", () => {
    const d = decodePlainDate("10000-01-01");
    expect(d.year).toBe(10000);
    expect(encodePlainDate(d)).toBe("10000-01-01");
  });
});

describe("time ⇄ PlainTime", () => {
  it("round-trips to microseconds", () => {
    const t = decodePlainTime("12:34:56.789012");
    expect(encodePlainTime(t)).toBe("12:34:56.789012");
  });
});

describe("timetz ⇄ { time, offset }", () => {
  it("decodes time and normalized offset", () => {
    const { time, offset } = decodeTimetz("12:34:56.789+05:30");
    expect(time.toString()).toBe("12:34:56.789");
    expect(offset).toBe("+05:30");
  });

  it("normalizes +00 to +00:00", () => {
    expect(decodeTimetz("12:00:00+00").offset).toBe("+00:00");
  });

  it("round-trips through encode", () => {
    expect(encodeTimetz(decodeTimetz("12:34:56+05:30"))).toBe("12:34:56.000000+05:30");
  });

  it("lossy time-only decode drops the offset", () => {
    expect(decodeTimetzTime("12:34:56+05:30").toString()).toBe("12:34:56");
  });
});

describe("precision surfacing (µs vs ns)", () => {
  it("Instant with ns tail throws by default", () => {
    const i = Temporal.Instant.from("2024-01-01T12:34:56.789012345Z");
    expect(() => encodeInstant(i)).toThrow(PrecisionError);
  });

  it("Instant with ns tail truncates when asked", () => {
    const i = Temporal.Instant.from("2024-01-01T12:34:56.789012345Z");
    expect(encodeInstant(i, { onSubMicrosecond: "truncate" })).toBe("2024-01-01T12:34:56.789012Z");
  });

  it("PlainTime with ns tail throws by default", () => {
    const t = Temporal.PlainTime.from("12:34:56.789012345");
    expect(() => encodePlainTime(t)).toThrow(PrecisionError);
  });
});
