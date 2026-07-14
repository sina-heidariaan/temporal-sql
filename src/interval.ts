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

/** First capture group as an integer, or 0 if the pattern is absent. */
function num(re: RegExp, text: string): number {
  const m = re.exec(text);
  return m ? parseInt(m[1] as string, 10) : 0;
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

/**
 * Parse the default `postgres` style (`1 year 2 mons 3 days 04:05:06`) and
 * `postgres_verbose` (`@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs [ago]`).
 * Date fields are individually signed; the `HH:MM:SS` clock carries one sign.
 */
function parsePostgres(raw: string): Fields {
  let body = raw;
  let overall = 1;
  if (body.startsWith("@")) body = body.slice(1).trim();
  if (/\bago\s*$/.test(body)) {
    overall = -1;
    body = body.replace(/\bago\s*$/, "").trim();
  }

  // `IntervalStyle = sql_standard` renders year-month as `±Y-M` (e.g. `+1-2 +3 +4:05:06`),
  // which this parser cannot read. Reject it explicitly rather than silently
  // grabbing only the clock component and returning a wrong Duration.
  if (/(^|\s)[+-]?\d+-\d+(\s|$)/.test(body)) {
    throw new UnsupportedValueError(
      `Interval "${raw}" looks like IntervalStyle=sql_standard, which is not supported. ` +
        `Set the session to the default 'postgres' style or 'iso_8601'.`,
    );
  }

  const years = num(/([+-]?\d+)\s+years?/, body);
  const months = num(/([+-]?\d+)\s+mons?/, body);
  const weeks = num(/([+-]?\d+)\s+weeks?/, body);
  const daysField = num(/([+-]?\d+)\s+days?/, body);

  // Verbose word clock (mutually exclusive with the HH:MM:SS form).
  const vHours = num(/([+-]?\d+)\s+hours?/, body);
  const vMins = num(/([+-]?\d+)\s+mins?/, body);
  const vSecsMatch = /([+-]?)(\d+)(?:\.(\d+))?\s+secs?/.exec(body);

  // Default `postgres` clock: one sign governs the whole HH:MM:SS[.frac].
  const clock = /([+-]?)(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(body);

  let hours = vHours;
  let minutes = vMins;
  let seconds = 0;
  let fracDigits = "";
  let clockSign = 1;

  if (clock) {
    clockSign = clock[1] === "-" ? -1 : 1;
    hours = clockSign * parseInt(clock[2] as string, 10);
    minutes = clockSign * parseInt(clock[3] as string, 10);
    seconds = clockSign * parseInt(clock[4] as string, 10);
    fracDigits = clock[5] ?? "";
  } else if (vSecsMatch) {
    clockSign = vSecsMatch[1] === "-" ? -1 : 1;
    seconds = clockSign * parseInt(vSecsMatch[2] as string, 10);
    fracDigits = vSecsMatch[3] ?? "";
  }

  const frac = splitFraction(fracDigits, clockSign);

  return {
    years: overall * years,
    months: overall * months,
    days: overall * (daysField + weeks * 7),
    hours: overall * hours,
    minutes: overall * minutes,
    seconds: overall * seconds,
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
