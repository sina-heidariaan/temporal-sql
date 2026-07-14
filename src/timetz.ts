/**
 * `timetz` ⇄ `{ time: PlainTime, offset }`.
 *
 * Temporal has no type carrying a time-of-day together with a UTC offset (and
 * `timetz` is discouraged in Postgres precisely because an offset without a date
 * is ambiguous across DST). We return a small struct rather than silently drop
 * the offset; `decodeTimetzTime` is offered for callers who explicitly want the
 * lossy time-only value.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import { encodePlainTime } from "./time.js";
import { splitOffset, type EncodeOptions } from "./shared.js";

export interface TimeWithOffset {
  time: Temporal.PlainTime;
  /** Normalized UTC offset, e.g. `"+05:30"` or `"+00:00"`. */
  offset: string;
}

/** Decode a `timetz` text value (`12:34:56.789+05:30`) to `{ time, offset }`. Lossless to µs. */
export function decodeTimetz(text: string): TimeWithOffset {
  const [body, offset] = splitOffset(text.trim());
  return { time: TEMPORAL_CTORS.PlainTime.from(body), offset };
}

/** Decode a `timetz`, discarding the offset (documented lossy — the offset is lost). */
export function decodeTimetzTime(text: string): Temporal.PlainTime {
  return decodeTimetz(text).time;
}

/** Encode a `{ time, offset }` to text Postgres accepts as `timetz`. */
export function encodeTimetz(value: TimeWithOffset, opts?: EncodeOptions): string {
  return encodePlainTime(value.time, opts) + value.offset;
}
