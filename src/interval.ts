/**
 * `interval` ⇄ `Temporal.Duration` — the headline codec.
 *
 * This is the piece people get wrong when they hand-roll: Postgres interval text
 * has several output styles, per-field signs, a single-sign clock component, and
 * fractional seconds; and `Temporal.Duration` forbids mixed-sign fields. This
 * module handles all of that and refuses (rather than corrupts) the cases that
 * genuinely cannot round-trip.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import {
  guardSubMicrosecond,
  MixedSignIntervalError,
  UnsupportedValueError,
  type EncodeOptions,
} from "./shared.js";

/** Signed sub-second components split from a fractional-seconds digit string. */
interface Fraction {
  milliseconds: number;
  microseconds: number;
  nanoseconds: number;
}

/** All Duration fields we populate; `weeks` is always folded into `days`. */
interface Fields extends Fraction {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Split a fractional-seconds digit string (`"789012"`) into signed ms/µs/ns. */
function splitFraction(fracDigits: string, sign: number): Fraction {
  const padded = (fracDigits + "000000000").slice(0, 9);
  return {
    milliseconds: sign * parseInt(padded.slice(0, 3), 10),
    microseconds: sign * parseInt(padded.slice(3, 6), 10),
    nanoseconds: sign * parseInt(padded.slice(6, 9), 10),
  };
}

const ISO_RE =
  /^([+-]?)P(?:([+-]?\d+)Y)?(?:([+-]?\d+)M)?(?:([+-]?\d+)W)?(?:([+-]?\d+)D)?(?:T(?:([+-]?\d+)H)?(?:([+-]?\d+)M)?(?:([+-]?\d+)(?:\.(\d+))?S)?)?$/i;

/**
 * Parse the ISO-8601 designator form (`IntervalStyle = iso_8601`). Postgres
 * emits negatives with a sign on each field (`P-3DT-4H-5M-6.5S`), which
 * `Temporal.Duration.from` rejects — so we parse it ourselves.
 */
function parseIso(raw: string): Fields {
  const m = ISO_RE.exec(raw);
  if (!m) throw new UnsupportedValueError(`Unparseable ISO-8601 interval: "${raw}"`);
  // Every field group is optional, so a bare `P`/`PT` (or sign-only `-P`) matches.
  // ISO-8601 requires at least one component; reject rather than return PT0S.
  if (m.slice(2, 9).every((g) => g === undefined)) {
    throw new UnsupportedValueError(`ISO-8601 interval "${raw}" has no duration fields.`);
  }
  const overall = m[1] === "-" ? -1 : 1;
  const int = (s: string | undefined): number => (s ? parseInt(s, 10) : 0);
  const weeks = int(m[4]);
  const secField = m[8];
  const secSign = secField && secField.startsWith("-") ? -1 : 1;
  const frac = splitFraction(m[9] ?? "", secSign);
  return {
    years: overall * int(m[2]),
    months: overall * int(m[3]),
    days: overall * (int(m[5]) + weeks * 7),
    hours: overall * int(m[6]),
    minutes: overall * int(m[7]),
    seconds: overall * int(secField),
    milliseconds: overall * frac.milliseconds,
    microseconds: overall * frac.microseconds,
    nanoseconds: overall * frac.nanoseconds,
  };
}

/** Units a Postgres-style interval can name. `weeks` is folded into days later. */
type Unit = "years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds";

/** Every unit word Postgres emits, singular and plural. */
const UNIT_WORDS: Record<string, Unit> = {
  year: "years",
  years: "years",
  mon: "months",
  mons: "months",
  month: "months",
  months: "months",
  week: "weeks",
  weeks: "weeks",
  day: "days",
  days: "days",
  hour: "hours",
  hours: "hours",
  min: "minutes",
  mins: "minutes",
  minute: "minutes",
  minutes: "minutes",
  sec: "seconds",
  secs: "seconds",
  second: "seconds",
  seconds: "seconds",
};

/** Default `postgres` clock: one sign governs the whole `HH:MM:SS[.frac]`. */
const CLOCK_RE = /([+-]?)(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/y;
/** A signed count followed by a unit word (`3 days`, `-2 mons`, `6.5 secs`). */
const UNIT_RE = /([+-]?)(\d+)(?:\.(\d+))?\s+([a-z]+)/iy;
const WS_RE = /\s*/y;

/**
 * Parse the default `postgres` style (`1 year 2 mons 3 days 04:05:06`) and
 * `postgres_verbose` (`@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs [ago]`).
 * Date fields are individually signed; the `HH:MM:SS` clock carries one sign.
 *
 * This is a strict left-to-right tokenizer, not a set of field searches: it
 * requires at least one component, rejects any unrecognized remainder, and
 * rejects repeated fields. Anything else would silently return a wrong Duration
 * for malformed input, contradicting {@link decodeDuration}'s contract.
 */
function parsePostgres(raw: string): Fields {
  let body = raw;
  let overall = 1;
  let verbose = false;
  if (body.startsWith("@")) {
    verbose = true;
    body = body.slice(1).trim();
  }
  if (/\bago\s*$/.test(body)) {
    overall = -1;
    body = body.replace(/\bago\s*$/, "").trim();
  }

  // `IntervalStyle = sql_standard` renders year-month as `±Y-M` (e.g. `+1-2 +3 +4:05:06`),
  // which this parser cannot read. Reject it with a targeted message rather than
  // letting it fall through to the generic "unparseable" error below.
  if (/(^|\s)[+-]?\d+-\d+(\s|$)/.test(body)) {
    throw new UnsupportedValueError(
      `Interval "${raw}" looks like IntervalStyle=sql_standard, which is not supported. ` +
        `Set the session to the default 'postgres' style or 'iso_8601'.`,
    );
  }

  const acc: Record<Unit, number> = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
  };

  // `postgres_verbose` renders a zero interval as the bare token `@ 0` — the one
  // real output with a count and no unit word, so the tokenizer below would
  // reject it. (Default style emits `00:00:00` and iso_8601 emits `PT0S`, both
  // of which tokenize normally.)
  if (verbose && body === "0") {
    return {
      years: 0,
      months: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      milliseconds: 0,
      microseconds: 0,
      nanoseconds: 0,
    };
  }
  const seen = new Set<Unit>();
  const claim = (unit: Unit): void => {
    if (seen.has(unit)) {
      throw new UnsupportedValueError(`Interval "${raw}" specifies ${unit} more than once.`);
    }
    seen.add(unit);
  };

  let fracDigits = "";
  let fracSign = 1;
  let cursor = 0;
  let components = 0;

  for (;;) {
    WS_RE.lastIndex = cursor;
    WS_RE.exec(body);
    cursor = WS_RE.lastIndex;
    if (cursor >= body.length) break;

    CLOCK_RE.lastIndex = cursor;
    const clock = CLOCK_RE.exec(body);
    if (clock) {
      // The clock carries all three fields at once, so it collides with the
      // verbose word forms (`4 hours 04:05:06` is not something Postgres emits).
      claim("hours");
      claim("minutes");
      claim("seconds");
      const sign = clock[1] === "-" ? -1 : 1;
      acc.hours = sign * parseInt(clock[2] as string, 10);
      acc.minutes = sign * parseInt(clock[3] as string, 10);
      acc.seconds = sign * parseInt(clock[4] as string, 10);
      fracDigits = clock[5] ?? "";
      fracSign = sign;
      cursor = CLOCK_RE.lastIndex;
      components++;
      continue;
    }

    UNIT_RE.lastIndex = cursor;
    const field = UNIT_RE.exec(body);
    if (field) {
      const word = field[4] as string;
      const unit = UNIT_WORDS[word.toLowerCase()];
      if (!unit) {
        throw new UnsupportedValueError(`Unrecognized unit "${word}" in interval "${raw}".`);
      }
      // Only seconds carry a fraction; Postgres never emits `1.5 days`.
      if (field[3] !== undefined && unit !== "seconds") {
        throw new UnsupportedValueError(`Fractional ${unit} are not supported in interval "${raw}".`);
      }
      claim(unit);
      const sign = field[1] === "-" ? -1 : 1;
      acc[unit] = sign * parseInt(field[2] as string, 10);
      if (unit === "seconds") {
        fracDigits = field[3] ?? "";
        fracSign = sign;
      }
      cursor = UNIT_RE.lastIndex;
      components++;
      continue;
    }

    throw new UnsupportedValueError(
      `Unparseable Postgres interval: "${raw}" (unrecognized text at offset ${cursor}).`,
    );
  }

  if (components === 0) {
    throw new UnsupportedValueError(`Unparseable Postgres interval: "${raw}" (no duration fields).`);
  }

  const frac = splitFraction(fracDigits, fracSign);

  return {
    years: overall * acc.years,
    months: overall * acc.months,
    days: overall * (acc.days + acc.weeks * 7),
    hours: overall * acc.hours,
    minutes: overall * acc.minutes,
    seconds: overall * acc.seconds,
    milliseconds: overall * frac.milliseconds,
    microseconds: overall * frac.microseconds,
    nanoseconds: overall * frac.nanoseconds,
  };
}

/** Enforce the uniform-sign invariant and build the Duration. */
function finalize(fields: Fields, sourceText: string): Temporal.Duration {
  let sign = 0;
  for (const v of Object.values(fields)) {
    if (v === 0) continue;
    const s = v < 0 ? -1 : 1;
    if (sign === 0) sign = s;
    else if (s !== sign) {
      throw new MixedSignIntervalError(
        `Postgres interval "${sourceText.trim()}" has mixed-sign fields, which cannot be represented ` +
          `as a single Temporal.Duration. Read it as a string, or store a normalized interval.`,
      );
    }
  }
  return TEMPORAL_CTORS.Duration.from(fields);
}

/**
 * Decode a Postgres `interval` string to a `Temporal.Duration`.
 *
 * Supports the default `postgres` style (`1 year 2 mons 3 days 04:05:06`),
 * `postgres_verbose` (`@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs [ago]`),
 * and `iso_8601` (`P1Y2M3DT4H5M6S`, incl. per-field-sign negatives). Weeks are
 * folded into days.
 *
 * @throws {MixedSignIntervalError} when field signs differ (not representable).
 * @throws {UnsupportedValueError} when the string cannot be parsed.
 */
export function decodeDuration(text: string): Temporal.Duration {
  const raw = text.trim();
  const fields = /^[+-]?P/i.test(raw) ? parseIso(raw) : parsePostgres(raw);
  return finalize(fields, text);
}

/**
 * Encode a `Temporal.Duration` to an ISO-8601 duration string Postgres accepts
 * as `interval` input (e.g. `P1Y2M3DT4H5M6.789S`).
 *
 * Two Postgres-specific adjustments over `Duration.toString()`:
 *   - Weeks are folded into days (ISO-8601 forbids combining `W` with other
 *     elements, and Postgres would reject `P1W`).
 *   - Negative durations are emitted with a sign on each field
 *     (`P-1Y-2M-3DT...`) rather than a single leading `-P...`, which Postgres
 *     rejects with "invalid input syntax for type interval".
 *
 * Sub-microsecond precision is guarded per {@link EncodeOptions}.
 */
export function encodeDuration(value: Temporal.Duration, opts?: EncodeOptions): string {
  const hasSubMicro = value.nanoseconds % 1000 !== 0;
  guardSubMicrosecond(hasSubMicro, opts, "Duration");

  let v = value;
  if (v.weeks !== 0) v = v.with({ weeks: 0, days: v.days + v.weeks * 7 });
  if (hasSubMicro) v = v.with({ nanoseconds: v.nanoseconds - (v.nanoseconds % 1000) });

  const iso = v.toString();
  // Temporal renders negatives as "-P1Y2M...S"; Postgres wants the sign per field.
  if (iso.startsWith("-")) {
    return "P" + iso.slice(2).replace(/(\d[\d.]*)/g, "-$1");
  }
  return iso;
}
