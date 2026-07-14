import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { decodeDuration, encodeDuration } from "../src/interval.js";
import { MixedSignIntervalError, PrecisionError } from "../src/shared.js";

describe("decodeDuration — postgres default style", () => {
  it("full positive interval", () => {
    const d = decodeDuration("1 year 2 mons 3 days 04:05:06");
    expect(d.years).toBe(1);
    expect(d.months).toBe(2);
    expect(d.days).toBe(3);
    expect(d.hours).toBe(4);
    expect(d.minutes).toBe(5);
    expect(d.seconds).toBe(6);
  });

  it("singular unit names (1 mon, 1 day, 1 year)", () => {
    const d = decodeDuration("1 year 1 mon 1 day");
    expect([d.years, d.months, d.days]).toEqual([1, 1, 1]);
  });

  it("all-negative interval", () => {
    const d = decodeDuration("-1 years -2 mons -3 days -04:05:06");
    expect(d.sign).toBe(-1);
    expect(d.years).toBe(-1);
    expect(d.hours).toBe(-4);
    expect(d.seconds).toBe(-6);
  });

  it("clock-only interval with hours > 23", () => {
    const d = decodeDuration("25:00:00");
    expect(d.hours).toBe(25);
  });

  it("fractional seconds → ms + µs (6 digits)", () => {
    const d = decodeDuration("00:00:00.789012");
    expect(d.milliseconds).toBe(789);
    expect(d.microseconds).toBe(12);
    expect(d.nanoseconds).toBe(0);
  });

  it("fractional seconds as milliseconds only (.5)", () => {
    const d = decodeDuration("00:00:01.5");
    expect(d.seconds).toBe(1);
    expect(d.milliseconds).toBe(500);
  });

  it("negative fractional keeps sign across ms/µs", () => {
    const d = decodeDuration("-00:00:01.5");
    expect(d.seconds).toBe(-1);
    expect(d.milliseconds).toBe(-500);
    expect(d.sign).toBe(-1);
  });

  it("zero interval", () => {
    const d = decodeDuration("00:00:00");
    expect(d.sign).toBe(0);
  });
});

describe("decodeDuration — other styles", () => {
  it("iso_8601 style", () => {
    const d = decodeDuration("P1Y2M3DT4H5M6S");
    expect([d.years, d.months, d.days, d.hours]).toEqual([1, 2, 3, 4]);
  });

  it("postgres_verbose with ago negates all", () => {
    const d = decodeDuration("@ 1 year 2 mons 3 days ago");
    expect(d.years).toBe(-1);
    expect(d.months).toBe(-2);
    expect(d.days).toBe(-3);
  });

  it("postgres_verbose with word clock units", () => {
    const d = decodeDuration("@ 4 hours 5 mins 6 secs");
    expect([d.hours, d.minutes, d.seconds]).toEqual([4, 5, 6]);
  });

  it("iso_8601 negative with per-field signs (as Postgres emits)", () => {
    // Postgres in iso_8601 mode renders negatives as `P-3DT-4H-5M-6.5S`,
    // which Temporal.Duration.from cannot parse — our parser must.
    const d = decodeDuration("P-3DT-4H-5M-6.5S");
    expect(d.days).toBe(-3);
    expect(d.hours).toBe(-4);
    expect(d.seconds).toBe(-6);
    expect(d.milliseconds).toBe(-500);
    expect(d.sign).toBe(-1);
  });
});

describe("decodeDuration — sql_standard rejection", () => {
  it("throws rather than silently misparsing sql_standard year-month", () => {
    expect(() => decodeDuration("+1-2 +3 +4:05:06")).toThrow(/sql_standard/);
    expect(() => decodeDuration("-1-2")).toThrow(/sql_standard/);
  });
});

describe("decodeDuration — mixed sign rejection", () => {
  it("throws on 1 mon -3 days", () => {
    expect(() => decodeDuration("1 mon -3 days")).toThrow(MixedSignIntervalError);
  });

  it("throws on positive date + negative clock", () => {
    expect(() => decodeDuration("3 days -04:00:00")).toThrow(MixedSignIntervalError);
  });
});

describe("encodeDuration", () => {
  it("emits ISO-8601 Postgres accepts", () => {
    const d = Temporal.Duration.from({ years: 1, months: 2, days: 3, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 });
    expect(encodeDuration(d)).toBe("P1Y2M3DT4H5M6.789S");
  });

  it("folds weeks into days", () => {
    const d = Temporal.Duration.from({ weeks: 1, days: 2 });
    expect(encodeDuration(d)).toBe("P9D");
  });

  it("throws PrecisionError on sub-µs by default", () => {
    const d = Temporal.Duration.from({ seconds: 1, nanoseconds: 500 });
    expect(() => encodeDuration(d)).toThrow(PrecisionError);
  });

  it("truncates sub-µs when asked", () => {
    const d = Temporal.Duration.from({ nanoseconds: 1500 });
    expect(encodeDuration(d, { onSubMicrosecond: "truncate" })).toBe("PT0.000001S");
  });
});

describe("interval round-trip (to µs)", () => {
  const cases = ["P1Y2M3DT4H5M6.789012S", "P3D", "PT25H", "-P3DT4H5M6S", "PT0.5S"];
  for (const iso of cases) {
    it(iso, () => {
      const original = Temporal.Duration.from(iso);
      const round = decodeDuration(encodeDuration(original));
      expect(round.toString()).toBe(original.toString());
    });
  }

  it("round-trips the postgres-style clock text too", () => {
    const round = decodeDuration("1 year 2 mons 3 days 04:05:06.789012");
    expect(encodeDuration(round)).toBe("P1Y2M3DT4H5M6.789012S");
  });
});
