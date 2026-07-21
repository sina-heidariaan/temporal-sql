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

/** All-zero fields, used for the bare `0` that `sql_standard` emits for a zero interval. */
const ZERO_FIELDS: Fields = {
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

// `sql_standard` renders an interval as up to three space-separated tokens, in
// order: a year-month token `±Y-M`, a bare day integer `±D`, and a clock
// `±H:M:S[.frac]` — any subset.
//
// Signs are the subtle part. When a subset shares one sign, Postgres writes a
// leading sign and leaves the clock *unsigned*, so an unsigned clock inherits the
// day's sign: `-3 4:05:06` means -3 days AND -4:05:06 (verified against PG 16 —
// `extract` on `-3 4:05:06` yields all-negative fields). When the day-time part
// genuinely mixes signs, Postgres instead forces an explicit-sign form with a
// `+0-0` year-month prefix (`+0-0 +3 -4:05:06`), and `finalize` rejects that as a
// `MixedSignIntervalError`. So: use an explicit clock sign when present; otherwise
// inherit the day's sign.
const SS_YM = /^([+-]?)(\d+)-(\d+)$/;
const SS_CLOCK = /^([+-]?)(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const SS_DAY = /^([+-]?)(\d+)$/;

/** A year-month token anywhere in the string is an unambiguous `sql_standard` marker. */
const SS_HAS_YM = /(?:^|\s)[+-]?\d+-\d+(?:\s|$)/;
/**
 * A bare day integer immediately followed by a clock (`3 4:05:06`) is the other
 * `sql_standard` marker. The default `postgres` style never emits a bare integer
 * next to a clock — it always words the day (`3 days 04:05:06`) — so this cannot
 * false-match `postgres`/`postgres_verbose` output, nor a lone clock.
 */
const SS_HAS_DAY_CLOCK = /(?:^|\s)[+-]?\d+\s+[+-]?\d+:\d{2}:\d{2}(?:\.\d+)?(?:\s|$)/;

/** Route to {@link parseSqlStandard} only on an unambiguous marker (a lone clock stays `postgres`). */
function isSqlStandard(body: string): boolean {
  return SS_HAS_YM.test(body) || SS_HAS_DAY_CLOCK.test(body);
}

/**
 * Parse the `sql_standard` output style (`+1-2 +3 +4:05:06`). Strict, like
 * {@link parsePostgres}: every token must classify as year-month / day / clock,
 * each kind appears at most once, and the fixed order is enforced.
 */
function parseSqlStandard(raw: string): Fields {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let years = 0;
  let months = 0;
  let days = 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let fracDigits = "";
  let fracSign = 1;
  let haveYm = false;
  let haveDay = false;
  let haveClock = false;
  let daySign = 1; // resolved sign of the day token; fills an unsigned clock (see above)

  for (const tok of tokens) {
    let m: RegExpExecArray | null;
    if ((m = SS_YM.exec(tok))) {
      if (haveYm || haveDay || haveClock) {
        throw new UnsupportedValueError(`Misordered or repeated year-month in sql_standard interval "${raw}".`);
      }
      const sign = m[1] === "-" ? -1 : 1;
      years = sign * parseInt(m[2] as string, 10);
      months = sign * parseInt(m[3] as string, 10);
      haveYm = true;
    } else if ((m = SS_CLOCK.exec(tok))) {
      if (haveClock) throw new UnsupportedValueError(`Repeated clock in sql_standard interval "${raw}".`);
      // An unsigned clock inherits the preceding day's sign; an explicit sign wins.
      const explicit = m[1] === "+" || m[1] === "-";
      const sign = explicit ? (m[1] === "-" ? -1 : 1) : haveDay ? daySign : 1;
      hours = sign * parseInt(m[2] as string, 10);
      minutes = sign * parseInt(m[3] as string, 10);
      seconds = sign * parseInt(m[4] as string, 10);
      fracDigits = m[5] ?? "";
      fracSign = sign;
      haveClock = true;
    } else if ((m = SS_DAY.exec(tok))) {
      if (haveDay || haveClock) {
        throw new UnsupportedValueError(`Misordered or repeated day in sql_standard interval "${raw}".`);
      }
      daySign = m[1] === "-" ? -1 : 1;
      days = daySign * parseInt(m[2] as string, 10);
      haveDay = true;
    } else {
      throw new UnsupportedValueError(`Unrecognized token "${tok}" in sql_standard interval "${raw}".`);
    }
  }

  if (!haveYm && !haveDay && !haveClock) {
    throw new UnsupportedValueError(`Unparseable sql_standard interval: "${raw}" (no duration fields).`);
  }

  const frac = splitFraction(fracDigits, fracSign);
  return { years, months, days, hours, minutes, seconds, ...frac };
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
 * Supports **every** `IntervalStyle` Postgres can emit: the default `postgres`
 * style (`1 year 2 mons 3 days 04:05:06`), `postgres_verbose`
 * (`@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs [ago]`), `iso_8601`
 * (`P1Y2M3DT4H5M6S`, incl. per-field-sign negatives), and `sql_standard`
 * (`+1-2 +3 +4:05:06`, incl. its bare `0` for a zero interval). Weeks are folded
 * into days.
 *
 * @throws {MixedSignIntervalError} when field signs differ (not representable).
 * @throws {UnsupportedValueError} when the string cannot be parsed.
 */
export function decodeDuration(text: string): Temporal.Duration {
  const raw = text.trim();
  let fields: Fields;
  if (raw === "0") fields = ZERO_FIELDS; // `sql_standard` renders a zero interval as bare `0`.
  else if (/^[+-]?P/i.test(raw)) fields = parseIso(raw);
  else if (isSqlStandard(raw)) fields = parseSqlStandard(raw);
  else fields = parsePostgres(raw);
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
