/**
 * `timestamp` (without time zone) ⇄ `Temporal.PlainDateTime`.
 * A wall-clock value with no offset and no zone.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import { guardSubMicrosecond, rejectInfinity, UnsupportedValueError, type EncodeOptions } from "./shared.js";

/** Decode a `timestamp` text value (`2024-01-01 12:34:56.789`) to a `PlainDateTime`. Lossless to µs. */
export function decodePlainDateTime(text: string): Temporal.PlainDateTime {
  rejectInfinity(text);
  const t = text.trim();
  if (/\bBC\b/i.test(t)) {
    throw new UnsupportedValueError(`BC timestamps are not supported by the timestamp codec: "${t}"`);
  }
  return TEMPORAL_CTORS.PlainDateTime.from(t.replace(" ", "T"));
}

/** Encode a `PlainDateTime` to text Postgres accepts as `timestamp` (space-separated, µs precision). */
export function encodePlainDateTime(value: Temporal.PlainDateTime, opts?: EncodeOptions): string {
  guardSubMicrosecond(value.nanosecond !== 0, opts, "PlainDateTime");
  return value.toString({ smallestUnit: "microsecond" }).replace("T", " ");
}
