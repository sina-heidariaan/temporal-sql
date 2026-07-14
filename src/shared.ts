/**
 * Options, error types, and low-level helpers shared by every codec.
 * No driver dependencies here — pure string/Temporal logic only.
 */

/** How `encode*` reacts when a Temporal value carries sub-microsecond (nanosecond) precision. */
export type SubMicrosecondMode = "throw" | "truncate";

export interface EncodeOptions {
  /**
   * Postgres stores date/time to microsecond precision; Temporal is nanosecond.
   * When a value has a non-zero nanosecond tail:
   *   - `"throw"` (default): raise {@link PrecisionError} so data loss is never silent.
   *   - `"truncate"`: drop the sub-microsecond tail (toward zero) and continue.
   */
  onSubMicrosecond?: SubMicrosecondMode;
}

/** Thrown by `encode*` when a value has sub-microsecond precision and mode is `"throw"`. */
export class PrecisionError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PrecisionError";
  }
}

/**
 * Thrown by `decodeDuration` when a Postgres `interval` mixes field signs
 * (e.g. `1 mon -3 days`). Such a value is not representable as a single
 * `Temporal.Duration`, which requires all non-zero fields to share one sign,
 * and months-vs-days cannot be losslessly rebalanced (calendar-ambiguous).
 */
export class MixedSignIntervalError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "MixedSignIntervalError";
  }
}

/** Thrown when a SQL value has no Temporal representation (e.g. `infinity`, `-infinity`). */
export class UnsupportedValueError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedValueError";
  }
}

const OFFSET_RE = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/;

/**
 * Normalize a Postgres offset token to a Temporal-valid numeric UTC offset.
 *
 * Accepts `Z`, `+00`, `-08`, `+05:30`, `+05:30:15` (and colon-less `+0530`).
 * Always returns numeric `±HH:MM` (with `:SS` when present), never bare `±HH`,
 * because `Temporal.Instant.from` requires at least `±HH:MM`. `Z`/`+00`/`-00`
 * become `+00:00`.
 */
export function normalizeOffset(raw: string): string {
  if (raw === "Z" || raw === "z") return "+00:00";
  const m = OFFSET_RE.exec(raw);
  if (!m) throw new UnsupportedValueError(`Unrecognized UTC offset: "${raw}"`);
  const [, sign, hh, mm = "00", ss] = m;
  return `${sign}${hh}:${mm}${ss ? `:${ss}` : ""}`;
}

/** Split a `body<offset>` string into `[body, normalizedOffset]`. Throws if no trailing offset. */
export function splitOffset(text: string): [body: string, offset: string] {
  const m = /([+-]\d{2}(?::?\d{2}){0,2}|[Zz])$/.exec(text);
  if (!m) throw new UnsupportedValueError(`Missing UTC offset in: "${text}"`);
  const body = text.slice(0, text.length - m[0].length);
  return [body, normalizeOffset(m[0])];
}

const mode = (opts?: EncodeOptions): SubMicrosecondMode => opts?.onSubMicrosecond ?? "throw";

/**
 * Enforce the microsecond-precision boundary on encode. Call with whether the
 * value has a non-zero nanosecond tail. Throws in `"throw"` mode; returns
 * quietly in `"truncate"` mode (the caller is responsible for the truncation,
 * usually via `toString({ smallestUnit: "microsecond" })`).
 */
export function guardSubMicrosecond(hasSubMicrosecond: boolean, opts: EncodeOptions | undefined, what: string): void {
  if (hasSubMicrosecond && mode(opts) === "throw") {
    throw new PrecisionError(
      `${what} has sub-microsecond (nanosecond) precision, which Postgres cannot store. ` +
        `Pass { onSubMicrosecond: "truncate" } to drop it, or round the value first.`,
    );
  }
}

/** Reject Postgres `infinity` / `-infinity`, which have no finite Temporal value. */
export function rejectInfinity(text: string): void {
  const t = text.trim().toLowerCase();
  if (t === "infinity" || t === "-infinity" || t === "+infinity") {
    throw new UnsupportedValueError(
      `Postgres "${text.trim()}" has no Temporal representation; read it as a string instead.`,
    );
  }
}
