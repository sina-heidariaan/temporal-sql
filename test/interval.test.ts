import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { decodeDuration, encodeDuration } from "../src/interval.js";
import { MixedSignIntervalError, PrecisionError, UnsupportedValueError } from "../src/shared.js";

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

describe("decodeDuration — sql_standard style", () => {
  it("full interval with all three tokens", () => {
    const d = decodeDuration("+1-2 +3 +4:05:06");
    expect([d.years, d.months, d.days, d.hours, d.minutes, d.seconds]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("year-month-only token", () => {
    const d = decodeDuration("1-2");
    expect([d.years, d.months, d.days]).toEqual([1, 2, 0]);
  });

  it("negative year-month applies the sign to both fields", () => {
    const d = decodeDuration("-1-2");
    expect([d.years, d.months]).toEqual([-1, -2]);
    expect(d.sign).toBe(-1);
  });

  it("day-time-only (bare day integer next to a clock)", () => {
    const d = decodeDuration("3 4:05:06");
    expect([d.years, d.days, d.hours, d.minutes, d.seconds]).toEqual([0, 3, 4, 5, 6]);
  });

  it("all-negative interval (explicit clock sign, as PG emits with a year-month)", () => {
    const d = decodeDuration("-1-2 -3 -4:05:06");
    expect(d.sign).toBe(-1);
    expect([d.years, d.days, d.hours, d.seconds]).toEqual([-1, -3, -4, -6]);
  });

  it("unsigned clock inherits the day's sign (PG's same-sign day-time form)", () => {
    // Verified against PG 16: `-3 days -4:05:06` renders as `-3 4:05:06`, and the
    // unsigned clock is negative — not a mixed-sign +4:05:06.
    const d = decodeDuration("-3 4:05:06");
    expect([d.days, d.hours, d.minutes, d.seconds]).toEqual([-3, -4, -5, -6]);
    expect(d.sign).toBe(-1);
  });

  it("unsigned positive day-time stays positive", () => {
    const d = decodeDuration("3 4:05:06");
    expect([d.days, d.hours, d.minutes, d.seconds]).toEqual([3, 4, 5, 6]);
  });

  it("genuinely mixed day-time (PG's forced +0-0 explicit-sign form) throws", () => {
    // `3 days -4:05:06` → PG renders `+0-0 +3 -4:05:06`; not representable.
    expect(() => decodeDuration("+0-0 +3 -4:05:06")).toThrow(MixedSignIntervalError);
  });

  it("fractional seconds on the clock", () => {
    const d = decodeDuration("+0-0 +0 +0:00:01.5");
    expect(d.seconds).toBe(1);
    expect(d.milliseconds).toBe(500);
  });

  it("bare 0 (the zero interval) decodes to a zero Duration", () => {
    const d = decodeDuration("0");
    expect(d.sign).toBe(0);
    expect(d.toString()).toBe("PT0S");
  });

  it("mixed-sign across parts is not representable and throws", () => {
    expect(() => decodeDuration("+1-2 -3 +4:05:06")).toThrow(MixedSignIntervalError);
  });

  it("year-month + day without a clock", () => {
    const d = decodeDuration("1-2 3");
    expect([d.years, d.months, d.days, d.hours]).toEqual([1, 2, 3, 0]);
  });

  it("decode → encode round-trips to ISO", () => {
    expect(encodeDuration(decodeDuration("+1-2 +3 +4:05:06"))).toBe("P1Y2M3DT4H5M6S");
    expect(encodeDuration(decodeDuration("-1-2 -3 -4:05:06"))).toBe("P-1Y-2M-3DT-4H-5M-6S");
  });

  // Strictness parity with the postgres tokenizer: the fixed order
  // (year-month, day, clock) is enforced and each kind appears at most once.
  it.each([
    ["clock before year-month", "4:05:06 1-2"],
    ["day before year-month", "3 1-2"],
    ["duplicate day", "1-2 3 4 5:06:07"],
    ["duplicate clock", "1-2 4:05:06 5:06:07"],
    ["unknown trailing token", "1-2 foo"],
    ["unknown leading token", "foo 1-2"],
  ])("rejects malformed sql_standard: %s", (_label, input) => {
    expect(() => decodeDuration(input)).toThrow(UnsupportedValueError);
  });
});

describe("decodeDuration — strict parsing", () => {
  // Before v0.1.1 the postgres path harvested field regexes from anywhere in the
  // string, so these silently returned a wrong Duration instead of throwing.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["pure junk", "nonsense"],
    ["trailing junk", "1 day trailing"],
    ["leading junk", "garbage 1 day"],
    ["junk between fields", "1 day garbage 2 mons"],
    ["bare P", "P"],
    ["sign-only P", "-P"],
    ["empty time designator", "PT"],
    ["unknown unit word", "3 fortnights"],
    ["count with no unit", "3"],
    ["fractional non-seconds", "1.5 days"],
  ])("throws on %s", (_label, input) => {
    expect(() => decodeDuration(input)).toThrow(UnsupportedValueError);
  });

  it.each([
    ["repeated days", "1 day 2 days"],
    ["repeated years across spellings", "1 year 2 years"],
    ["repeated mons across spellings", "1 mon 2 months"],
    ["word clock colliding with HH:MM:SS", "4 hours 04:05:06"],
    ["repeated clock", "04:05:06 07:08:09"],
  ])("throws on %s", (_label, input) => {
    expect(() => decodeDuration(input)).toThrow(UnsupportedValueError);
  });

  it("keeps accepting a single component", () => {
    expect(decodeDuration("3 days").days).toBe(3);
    expect(decodeDuration("04:05:06").hours).toBe(4);
  });

  // Every shape Postgres's interval_out can actually emit must survive the
  // tokenizer. `@ 0` is the awkward one: a count with no unit word.
  it.each([
    ["postgres_verbose zero", "@ 0", "PT0S"],
    ["default-style zero", "00:00:00", "PT0S"],
    ["iso_8601 zero", "PT0S", "PT0S"],
    ["verbose single field", "@ 1 day", "P1D"],
    ["verbose ago", "@ 1 day ago", "-P1D"],
    ["verbose word clock", "@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs", "P1Y2M3DT4H5M6S"],
    ["default full", "1 year 2 mons 3 days 04:05:06", "P1Y2M3DT4H5M6S"],
    ["negative clock fraction", "-00:00:01.5", "-PT1.5S"],
  ])("accepts real Postgres output: %s", (_label, input, expected) => {
    expect(decodeDuration(input).toString()).toBe(expected);
  });

  it("accepts a bare 0 as the zero interval (sql_standard emits this)", () => {
    expect(decodeDuration("0").toString()).toBe("PT0S");
  });

  it("folds a weeks field into days", () => {
    expect(decodeDuration("2 weeks 1 day").days).toBe(15);
  });

  it('"-P-3D" cancels signs to P3D rather than throwing', () => {
    // Postgres never emits an overall sign together with per-field signs, so this
    // is not real DB output. -1 × -3 = +3 is coherent; locked in deliberately.
    // See private/temporal-sql-ship-v0.1.1.md.
    const d = decodeDuration("-P-3D");
    expect(d.days).toBe(3);
    expect(d.sign).toBe(1);
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
