/**
 * `time` (without time zone) ⇄ `Temporal.PlainTime`.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import { guardSubMicrosecond, type EncodeOptions } from "./shared.js";

/** Decode a `time` text value (`12:34:56.789`) to a `PlainTime`. Lossless to µs. */
export function decodePlainTime(text: string): Temporal.PlainTime {
  return TEMPORAL_CTORS.PlainTime.from(text.trim());
}

/** Encode a `PlainTime` to text Postgres accepts as `time` (µs precision). */
export function encodePlainTime(value: Temporal.PlainTime, opts?: EncodeOptions): string {
  guardSubMicrosecond(value.nanosecond !== 0, opts, "PlainTime");
  return value.toString({ smallestUnit: "microsecond" });
}
